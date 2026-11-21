const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const _ = require('lodash');
const iconv = require('iconv-lite');
const zlib = require('zlib');
const crypto = require('crypto');

const ZipReader = require('./ZipReader');
const WorkerState = require('./WorkerState');//singleton
const { JembaDb, JembaDbThread } = require('jembadb');
const DbCreator = require('./DbCreator');
const DbSearcher = require('./DbSearcher');
const InpxHashCreator = require('./InpxHashCreator');
const RemoteLib = require('./RemoteLib');//singleton
const FileDownloader = require('./FileDownloader');

const asyncExit = new (require('./AsyncExit'))();
const log = new (require('./AppLogger'))().log;//singleton
const utils = require('./utils');
const genreTree = require('./genres');
const { canonicalGenre } = require('./genres/genreUtils');
const Fb2Helper = require('./fb2/Fb2Helper');
const EpubHelper = require('./epub/EpubHelper');
const { bookContentType } = require('./book/bookFormats');
const { jxlConvert } = require('./book/bookImages');

// 7z read and covers
const { extractFb2Data } = require('./fb2/fb2Cover');
const { extractEpubData } = require('./epub/epubCover');
const BookAppendImages = require("./BookAppendImages");
const ReviewsReader = require('./ReviewsReader');
const AuthorBioReader = require('./AuthorBioReader');

const Favorites = require('./Favorites');
const UserData = require('./UserData');

//server states
const ssNormal = 'normal';
const ssDbLoading = 'db_loading';
const ssDbCreating = 'db_creating';
const ssDbReleased = 'db_released';

const stateToText = {
    [ssNormal]: '',
    [ssDbLoading]: 'Загрузка поисковой базы',
    [ssDbCreating]: 'Создание поисковой базы',
    [ssDbReleased]: 'Память освобождена, ожидание запроса',
};

const cleanDirInterval = 60*60*1000;//каждый час
const checkReleaseInterval = 7*60*60*1000;//каждые 7 часов

//детерминированный PRNG для стабильной случайности ленты
function stringHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function mulberry32(a) {
    return () => {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

//singleton
let instance = null;

class WebWorker {
    constructor(config) {
        if (!instance) {
            this.config = config;
            this.workerState = new WorkerState();

            this.remoteLib = null;
            if (config.remoteLib) {
                this.remoteLib = new RemoteLib(config);
            }
            
            this.inpxHashCreator = new InpxHashCreator(config);
            this.fb2Helper = new Fb2Helper();
            this.epubHelper = new EpubHelper();
            this.inpxFileHash = '';

            this.wState = this.workerState.getControl('server_state');
            this.myState = '';
            this.db = null;
            this.dbSearcher = null;

            this.lastActivity = Date.now();
            this._reloadPromise = null;

            asyncExit.add(this.closeDb.bind(this));

            this.loadOrCreateDb();//no await
            this.periodicLogServerStats();//no await
            this.periodicIdleRelease();//no await

            const dirConfig = [
                {
                    dir: config.bookDir,
                    maxSize: config.maxFilesDirSize,
                },
                {
                    dir: config.authorDir,
                    maxSize: config.maxAuthorPhotoDirSize || 20*1024*1024,
                },
            ];

            this.periodicCleanDir(dirConfig);//no await
            this.periodicCheckInpx();//no await
            this.periodicCheckNewRelease();//no await
            this.reviewsReader = null;
            this.authorBioReader = null;
            this._restoring = new Map();

            instance = this;
        }

        return instance;
    }

    noteActivity() {
        this.lastActivity = Date.now();
    }

    checkMyState() {
        //первый запрос после освобождения памяти — запускаем загрузку БД
        if (this.myState == ssDbReleased && !this._reloadPromise) {
            this._reloadPromise = this.loadOrCreateDb();
            this._reloadPromise.catch(() => {});
            this._reloadPromise.finally(() => { this._reloadPromise = null; });
        }
        if (this.myState != ssNormal)
            throw new Error('server_busy');
    }

    setMyState(newState, workerState = {}) {
        this.myState = newState;
        this.wState.set(Object.assign({}, workerState, {
            state: newState,
            serverMessage: stateToText[newState]
        }));
    }

    async closeDb() {
        if (this.db) {
            await this.db.unlock();
            this.db = null;
        }
    }

    async createDb(dbPath) {
        this.setMyState(ssDbCreating);
        log('Searcher DB create start');

        const config = this.config;

        if (await fs.pathExists(dbPath))
            throw new Error(`createDb.pathExists: ${dbPath}`);

        const db = new JembaDbThread();
        await db.lock({
            dbPath,
            create: true,
            softLock: true,

            tableDefaults: {
                cacheSize: config.dbCacheSize,
            },
        });

        try {
            const dbCreator = new DbCreator(config);        

            await dbCreator.run(db, (state) => {
                this.setMyState(ssDbCreating, state);

                if (state.fileName)
                    log(`  load ${state.fileName}`);
                if (state.recsLoaded)
                    log(`  processed ${state.recsLoaded} records`);
                if (state.job)
                    log(`  ${state.job}`);
            }, {indexesFromDump: !!this.remoteLib});

            log('Searcher DB successfully created');
        } finally {
            await db.unlock();
        }
    }

    async loadOrCreateDb(recreate = false, iteration = 0) {
        this.setMyState(ssDbLoading);

        try {
            const config = this.config;
            const dbPath = `${config.dataDir}/db`;

            this.inpxFileHash = await this.inpxHashCreator.getInpxFileHash();

            //проверим полный InxpHash (включая фильтр и версию БД)
            //для этого заглянем в конфиг внутри БД, если он есть
            if (!(config.recreateDb || recreate) && await fs.pathExists(dbPath)) {
                const newInpxHash = await this.inpxHashCreator.getHash();

                const tmpDb = new JembaDb();
                await tmpDb.lock({dbPath, softLock: true});

                try {
                    await tmpDb.open({table: 'config'});
                    const rows = await tmpDb.select({table: 'config', where: `@@id('inpxHash')`});

                    if (!rows.length || newInpxHash !== rows[0].value)
                        throw new Error('inpx file: changes found on start, recreating DB');
                } catch (e) {
                    log(LM_WARN, e.message);
                    recreate = true;
                } finally {
                    await tmpDb.unlock();
                }
            }

            //удалим БД если нужно
            if (config.recreateDb || recreate)
                await fs.remove(dbPath);
            
            // потребитель: обеспечить наличие валидных дампов индексов
            // (нужны для createDb, а также для случая "фича включена после создания БД")
            if (this.remoteLib) {
                const needCreate = !await fs.pathExists(dbPath);
                let needDownload = needCreate; // нет БД — нужны дампы

                if (!needDownload) {
                    // БД есть — проверим целостность локальных дампов
                    const reviewsOk = await this.remoteLib.isDumpValid(config, 'reviews_index.json.gz');
                    const authorsOk = await this.remoteLib.isDumpValid(config, 'authors_info.json.gz');
                    needDownload = !reviewsOk || !authorsOk;
                }

                if (needDownload) {
                    try {
                        const dumps = await this.remoteLib.downloadIndexes(config);
                        config.reviewsDumpFile = dumps.reviews_index || '';
                        config.authorsDumpFile = dumps.authors_info || '';
                    } catch (e) {
                        log(LM_WARN, `downloadIndexes failed: ${e.message}`);
                        config.reviewsDumpFile = '';
                        config.authorsDumpFile = '';
                    }
                } else {
                    // дампы целые — используем локальные
                    config.reviewsDumpFile = path.join(config.dataDir, 'reviews_index.json.gz');
                    config.authorsDumpFile = path.join(config.dataDir, 'authors_info.json.gz');
                }
            }

            //пересоздаем БД из INPX если нужно
            if (!await fs.pathExists(dbPath)) {
                await this.createDb(dbPath);
                utils.freeMemory();
            }

            //загружаем БД
            this.setMyState(ssDbLoading);
            log('Searcher DB loading');

            const db = new JembaDbThread();//в отдельном потоке
            await db.lock({
                dbPath,
                softLock: true,

                tableDefaults: {
                    cacheSize: config.dbCacheSize,
                },
            });

            try {
                //открываем таблицы
                await db.openAll({exclude: ['author_id', 'series_id', 'title_id', 'book', 'reviews_index', 'authors_info']});

                const bookCacheSize = 500;
                await db.open({
                    table: 'book',
                    cacheSize: (config.lowMemoryMode || config.dbCacheSize > bookCacheSize ? config.dbCacheSize : bookCacheSize)
                });
            } catch(e) {
                log(LM_ERR, `Database error: ${e.message}`);
                if (iteration < 1) {
                    log('Recreating DB');
                    await this.loadOrCreateDb(true, iteration + 1);
                } else
                    throw e;
                return;
            }

            //поисковый движок
            this.dbSearcher = new DbSearcher(config, db);
            await this.dbSearcher.init();

            //stuff
            db.wwCache = {};            
            this.db = db;

            this.setMyState(ssNormal);

            log('Searcher DB ready');

            const dbConfig = await this.dbConfig();
            // потребитель: если фича включена в конфиге, а индекса в БД нет — пересоздать
            if (this.remoteLib && iteration < 1) {
                const stats = dbConfig.stats || {};
                const providerIndexes = (this.remoteLib.providerFeatures && Array.isArray(this.remoteLib.providerFeatures.indexes))
                    ? this.remoteLib.providerFeatures.indexes
                    : [];
                const expectReviews = !!(config.reviewsEnabled && providerIndexes.includes('reviews_index'));
                const expectAuthors = !!(config.authorsBioEnabled && providerIndexes.includes('authors_info'));

                if (expectReviews !== !!stats.reviewsEnabled || expectAuthors !== !!stats.authorsBioEnabled) {
                    log(`DB indexes mismatch (reviews: ${!!stats.reviewsEnabled} -> ${expectReviews}, authors: ${!!stats.authorsBioEnabled} -> ${expectAuthors}), recreating DB`);
                    await this.closeDb();
                    if (this.dbSearcher) { await this.dbSearcher.close(); this.dbSearcher = null; }
                    await this.loadOrCreateDb(true, iteration + 1);
                    return;
                }
            }

            // рецензии — после перехода в normal
            const reviewsEnabled = dbConfig.stats && dbConfig.stats.reviewsEnabled;

            if (reviewsEnabled) {
                try {
                    await db.open({table: 'reviews_index', cacheSize: 50});
                    this.reviewsReader = new ReviewsReader(this.config, db);
                    log('Reviews index ready');
                } catch (e) {
                    log(LM_WARN, `reviews_index not found, but reviewsEnabled=true. Recreate DB to build index.`);
                    this.reviewsReader = null;
                }
            } else {
                this.reviewsReader = null;
            }
            // авторы — после перехода в normal
            const authorsBioEnabled = dbConfig.stats && dbConfig.stats.authorsBioEnabled;

            if (authorsBioEnabled) {
                try {
                    await db.open({table: 'authors_info', cacheSize: 50});
                    this.authorBioReader = new AuthorBioReader(this.config, db);
                    log('Authors index ready');
                } catch (e) {
                    log(LM_WARN, `authors_info not found, but authorsBioEnabled=true. Recreate DB to build index.`);
                    this.authorBioReader = null;
                }
            } else {
                this.authorBioReader = null;
            }
            this.logServerStats();
        } catch (e) {
            log(LM_FATAL, e.message);            
            asyncExit.exit(1);
        }
    }

    async recreateDb() {
        this.setMyState(ssDbCreating);

        if (this.dbSearcher) {
            await this.dbSearcher.close();
            this.dbSearcher = null;
        }

        await this.closeDb();

        await this.loadOrCreateDb(true);
    }

    async releaseMemory() {
        if (this.myState != ssNormal)
            return;

        const memBefore = process.memoryUsage().rss;
        log(`Idle timeout: releasing memory, rss=${(memBefore/1024/1024).toFixed(1)}MB`);

        this.setMyState(ssDbLoading);

        try {
            if (this.dbSearcher) {
                await this.dbSearcher.close();
                this.dbSearcher = null;
            }

            this.reviewsReader = null;
            this.authorBioReader = null;
            this._restoring.clear();

            await this.closeDb();
        } finally {
            this.setMyState(ssDbReleased);
        }

        this.lastActivity = Date.now();
        utils.freeMemory();

        const memAfter = process.memoryUsage().rss;
        log(`Memory released: rss ${(memBefore/1024/1024).toFixed(1)}MB -> ${(memAfter/1024/1024).toFixed(1)}MB`);
    }

    async periodicIdleRelease() {
        const idleInterval = this.config.idleReleaseInterval;
        if (!idleInterval)
            return;

        while (1) {// eslint-disable-line no-constant-condition
            await utils.sleep(60*1000);//интервал проверки 1 минута
            if (this.myState == ssNormal && Date.now() - this.lastActivity >= idleInterval) {
                if (this.config.idleExit) {
                    //полный выход процесса (работает под watchdog)
                    const mem = process.memoryUsage().rss;
                    log(`Idle timeout: exiting to release memory, rss=${(mem/1024/1024).toFixed(1)}MB`);
                    asyncExit.exit(0);
                } else {
                    await this.releaseMemory();
                }
            }
        }
    }

    async dbConfig() {
        this.checkMyState();

        const db = this.db;
        if (!db.wwCache.config) {
            const rows = await db.select({table: 'config'});
            const config = {};

            for (const row of rows) {
                config[row.id] = row.value;
            }

            db.wwCache.config = config;
        }

        return db.wwCache.config;
    }

    async search(from, query) {
        this.checkMyState();

        const result = await this.dbSearcher.search(from, query);

        const config = await this.dbConfig();
        result.inpxHash = (config.inpxHash ? config.inpxHash : '');

        return result;
    }

    async bookSearch(query) {
        this.checkMyState();

        const result = await this.dbSearcher.bookSearch(query);

        const config = await this.dbConfig();
        result.inpxHash = (config.inpxHash ? config.inpxHash : '');

        return result;
    }

    async bookSearchAny(query) {
        this.checkMyState();

        const result = await this.dbSearcher.bookSearchAny(query);

        const config = await this.dbConfig();
        result.inpxHash = (config.inpxHash ? config.inpxHash : '');

        return result;
    }

    async selectBookIds(query) {
        this.checkMyState();
        return await this.dbSearcher.selectBookIds(query);
    }

    async getBooksByIds(ids) {
        this.checkMyState();
        if (!ids || !ids.length)
            return [];
        return await this.db.select({table: 'book', where: `@@id(${this.db.esc(Array.from(ids))})`});
    }

    async opdsQuery(from, query) {
        this.checkMyState();

        return await this.dbSearcher.opdsQuery(from, query);
    }

    async getAuthorBookList(authorId, author) {
        this.checkMyState();

        return await this.dbSearcher.getAuthorBookList(authorId, author);
    }

    async getAuthorSeriesList(authorId) {
        this.checkMyState();

        return await this.dbSearcher.getAuthorSeriesList(authorId);
    }

    async getSeriesBookList(series) {
        this.checkMyState();

        return await this.dbSearcher.getSeriesBookList(series);
    }

    async getGenreTree() {
        this.checkMyState();

        const config = await this.dbConfig();

        let result;
        const db = this.db;
        if (!db.wwCache.genreTree) {
            const genres = _.cloneDeep(genreTree);
            const last = genres[genres.length - 1];

            const genreValues = new Set();
            for (const section of genres) {
                for (const g of section.value)
                    genreValues.add(g.value);
            }

            //добавим к жанрам те, что нашлись при парсинге
            const genreParsed = new Set();
            let rows = await db.select({table: 'genre', map: `(r) => ({value: r.value})`});
            for (const row of rows) {
                genreParsed.add(row.value);
                // алиасы не показываем в «Прочее» — они отображаются под каноном
                if (canonicalGenre(row.value) !== row.value)
                    continue;
                if (!genreValues.has(row.value))
                    last.value.push({name: row.value, value: row.value});
            }

            //уберем те, которые не нашлись при парсинге
            for (let j = 0; j < genres.length; j++) {
                const section = genres[j];
                for (let i = 0; i < section.value.length; i++) {
                    const g = section.value[i];
                    if (!genreParsed.has(g.value))
                        section.value.splice(i--, 1);
                }

                if (!section.value.length)
                    genres.splice(j--, 1);
            }

            // langs
            rows = await db.select({table: 'lang', map: `(r) => ({value: r.value})`});
            const langs = rows.map(r => r.value);            

            // exts
            rows = await db.select({table: 'ext', map: `(r) => ({value: r.value})`});
            const exts = rows.map(r => r.value);            

            result = {
                genreTree: genres,
                langList: langs,
                extList: exts,
                inpxHash: (config.inpxHash ? config.inpxHash : ''),
            };

            db.wwCache.genreTree = result;
        } else {
            result = db.wwCache.genreTree;
        }

        return result;
    }

    async getGenreMap() {
        this.checkMyState();

        let result;
        const db = this.db;
        if (!db.wwCache.genreMap) {
            const genreTree = await this.getGenreTree();

            result = new Map();
            for (const section of genreTree.genreTree) {
                for (const g of section.value)
                    result.set(g.value, g.name);
            }

            db.wwCache.genreMap = result;
        } else {
            result = db.wwCache.genreMap;
        }

        return result;
    }

    //----------------------------------------------------------------------------
    //tile-интерфейс

    async getTilePools() {
        this.checkMyState();

        const db = this.db;
        const config = await this.dbConfig();
        const inpxHash = (config.inpxHash ? config.inpxHash : '');

        if (db.wwCache.tilePools && db.wwCache.tilePools.inpxHash === inpxHash)
            return db.wwCache.tilePools;

        const genreTree = await this.getGenreTree();
        const sections = genreTree.genreTree.map((s) => ({
            name: s.name,
            values: s.value.map((g) => g.value),
        }));
        const years = [2022, 2023, 2024, 2025, 2026];

        const pools = await this.dbSearcher.tilePools(sections, years);

        //топ-200 авторов по средней оценке (только оцененные книги)
        const idMap = this.dbSearcher.bookIdMap['author'];
        const agg = new Map();
        const ratedIds = pools.ratedIds;
        const ratedRates = pools.ratedRates;
        pools.ratedIds = null;
        pools.ratedRates = null;

        const addAgg = (agg, aid, rate) => {
            let a = agg.get(aid);
            if (!a) {
                a = {id: aid, sum: 0, count: 0};
                agg.set(aid, a);
            }
            a.sum += rate;
            a.count++;
        };

        for (let i = 0; i < ratedIds.length; i++) {
            const bid = ratedIds[i];
            const tId = idMap.arr[bid];
            if (tId) {
                addAgg(agg, tId, ratedRates[i]);
            } else {
                const tIds = idMap.map.get(bid);
                if (tIds)
                    for (const aid of tIds)
                        addAgg(agg, aid, ratedRates[i]);
            }
        }

        const authors = [];
        for (const a of agg.values())
            authors.push({id: a.id, avg: a.sum / a.count, count: a.count});
        authors.sort((a, b) => (b.avg - a.avg) || (b.count - a.count));

        db.wwCache.tilePools = {inpxHash, pools, authors: authors.slice(0, 200)};
        return db.wwCache.tilePools;
    }

    //одна выборка записей таблицы (author/series) по набору названий
    async nameToRowMap(table, names) {
        const list = Array.from(new Set(names));
        if (!list.length)
            return new Map();

        const db = this.db;
        const rows = await db.select({
            table,
            map: `(r) => ({value: r.value, id: r.id, bookCount: r.bookCount})`,
            where: `
                const names = ${db.esc(list)};
                const ids = new Set();
                for (const n of names) {
                    for (const id of @dirtyIndexLR('value', n.toLowerCase(), n.toLowerCase()))
                        ids.add(id);
                }
                return ids;
            `,
        });

        const byValue = new Map(rows.map((r) => [r.value, r]));
        const result = new Map();
        for (const n of list) {
            const row = byValue.get(n.toLowerCase());
            if (row)
                result.set(n, row);
        }
        return result;
    }

    //подставляем authorId (id первого автора) в записи книг
    async addAuthorIds(rows) {
        const names = new Set();
        for (const b of rows) {
            const a = (b.author ? b.author.split(',')[0] : '').trim();
            if (a)
                names.add(a);
        }

        const map = await this.nameToRowMap('author', names);
        for (const b of rows) {
            const a = (b.author ? b.author.split(',')[0] : '').trim();
            const row = (a ? map.get(a) : null);
            b.authorId = (row ? row.id : 0);
        }
    }

    async getTileHome(seed, profile) {
        this.checkMyState();

        seed = (parseInt(seed, 10) || 0) >>> 0;

        const {pools, authors} = await this.getTilePools();

        //профиль: игнор книг/авторов/серий и отключённые ленты
        let ud = null;
        if (profile) {
            const user = new UserData(this.config);
            ud = await user.getData(profile);
        }
        const sets = ud ? this.tileIgnoredSets(ud) : null;

        //детерминированный выбор из пулов: seed + ключ ленты
        const seedFor = (key) => mulberry32(seed ^ stringHash(key));
        const sample = (arr, n, key) => {
            const rnd = seedFor(key);
            const a = arr.slice();
            const m = Math.min(n, a.length);
            for (let i = 0; i < m; i++) {
                const j = i + Math.floor(rnd() * (a.length - i));
                const t = a[i]; a[i] = a[j]; a[j] = t;
            }
            return a.slice(0, m);
        };

        const sectionNames = [];
        const {genreTree} = await this.getGenreTree();
        for (const s of genreTree)
            sectionNames.push(s.name);

        const db = this.db;
        const needIds = new Set();
        const addNeed = (rows) => {
            for (const r of rows)
                needIds.add(r.id);
        };

        const newBooks = sample(pools.new, 20, 'home-new');
        addNeed(newBooks);

        const topBooks = sample(pools.top, 20, 'home-top');
        addNeed(topBooks);

        //серии: группируем последние/топ-200 книг, берем 20 случайных серий
        const seriesCards = (rows, key) => {
            const list = rows.slice(0, 200);
            const groups = new Map();
            for (const b of list) {
                if (!b.series)
                    continue;
                let g = groups.get(b.series);
                if (!g) {
                    g = [];
                    groups.set(b.series, g);
                }
                g.push(b);
            }
            const names = Array.from(groups.keys());
            const picked = sample(names, 20, key);
            return picked.map((name) => {
                const g = groups.get(name);
                g.sort((a, b) => (a.serno - b.serno) || (a.insno - b.insno));
                return {series: name, book: g[0]};
            });
        };
        const seriesNew = seriesCards(pools.new, 'home-series-new');
        const seriesTop = seriesCards(pools.top, 'home-series-top');
        for (const c of seriesNew.concat(seriesTop))
            addNeed([c.book]);

        //количество книг в каждой серии
        const seriesMap = await this.nameToRowMap('series', seriesNew.concat(seriesTop).map((c) => c.series));
        for (const c of seriesNew.concat(seriesTop)) {
            const row = seriesMap.get(c.series);
            c.count = (row ? row.bookCount : 0);
        }

        const yearFeeds = [];
        for (const y of [2022, 2023, 2024, 2025, 2026]) {
            const arr = pools.years[y] || [];
            if (arr.length) {
                const books = sample(arr, 20, `home-year-${y}`);
                addNeed(books);
                yearFeeds.push({year: y, books});
            }
        }

        //жанры: по каждой секции — «новые» (фильтр из pools.new) и «лучшие»
        const genreFeeds = [];
        for (let i = 0; i < genreTree.length; i++) {
            const vset = new Set(genreTree[i].value.map((g) => g.value));
            const recent = [];
            for (const b of pools.new) {
                if (recent.length >= 200)
                    break;
                if (b.genre) {
                    const gs = b.genre.split(',');
                    for (const g of gs) {
                        if (vset.has(g)) {
                            recent.push(b);
                            break;
                        }
                    }
                }
            }
            const feed = {
                name: sectionNames[i],
                value: genreTree[i].value.map((g) => g.value).join(','),
                new: sample(recent, 20, `genre-new-${i}`),
                best: sample(pools.sections[i] || [], 20, `genre-best-${i}`),
            };
            addNeed(feed.new.concat(feed.best));
            genreFeeds.push(feed);
        }

        //авторы: 8 случайных из топ-200, у каждого случайная книга
        const pickedAuthors = sample(authors, 8, 'home-authors');
        const authorCards = [];
        if (pickedAuthors.length) {
            const rows = await db.select({
                table: 'author',
                where: `@@id(${db.esc(pickedAuthors.map((a) => a.id))})`
            });
            const byId = new Map(rows.map((r) => [r.id, r]));

            for (const a of pickedAuthors) {
                const row = byId.get(a.id);
                if (!row || !row.bookIds || !row.bookIds.length)
                    continue;

                const rnd = seedFor(`author-${a.id}`);
                const bid = row.bookIds[Math.floor(rnd() * row.bookIds.length)];
                needIds.add(bid);
                authorCards.push({id: a.id, name: row.name, avg: a.avg, count: a.count, bookId: bid});
            }
        }

        //одна выборка всех нужных записей книг
        const bookRows = needIds.size ?
            await db.select({table: 'book', where: `@@id(${db.esc(Array.from(needIds))})`}) : [];
        await this.addAuthorIds(bookRows);
        const rowById = new Map(bookRows.map((r) => [r.id, r]));
        const getRow = (b) => (rowById.get(b.id) || b);

        const keep = (b) => (!sets || !this.tileBookIgnored(sets, b));
        const keepList = (arr) => (sets ? arr.filter(keep) : arr);
        const keepSeries = (c) => (!sets || (!sets.series.has((c.series || '').toLowerCase()) && keep(c.book)));

        const result = {
            seed,
            new: keepList(newBooks.map(getRow)),
            top: keepList(topBooks.map(getRow)),
            seriesNew: seriesNew.filter((c) => keepSeries(c)).map((c) => ({series: c.series, count: c.count, book: getRow(c.book)})),
            seriesTop: seriesTop.filter((c) => keepSeries(c)).map((c) => ({series: c.series, count: c.count, book: getRow(c.book)})),
            years: yearFeeds.map((f) => ({year: f.year, books: keepList(f.books.map(getRow))})),
            genres: genreFeeds.map((f) => ({...f, new: keepList(f.new.map(getRow)), best: keepList(f.best.map(getRow))})),
            authors: authorCards
                .filter((c) => (!sets || !sets.authors.has(String(c.id))) && keep(rowById.get(c.bookId)))
                .map((c) => ({
                    id: c.id, name: c.name, avg: c.avg, count: c.count,
                    book: (rowById.get(c.bookId) || null),
                })),
        };

        if (ud) {
            result.profile = profile;
            result.readUids = Object.keys(ud.read);
            result.disabledFeeds = ud.disabledFeeds.slice();
        }

        return result;
    }

    //наборы игнорируемых книг/авторов/серий профиля
    tileIgnoredSets(ud) {
        return {
            uids: new Set(ud.ignored.books.map((b) => b.uid)),
            authors: new Set(ud.ignored.authors.map((a) => String(a.id))),
            series: new Set(ud.ignored.series.map((s) => (s.name || '').toLowerCase())),
        };
    }

    //книга под игнором: по uid, первому автору или серии
    tileBookIgnored(sets, b) {
        if (!b)
            return true;
        if (sets.uids.has(b._uid))
            return true;
        if (b.authorId && sets.authors.has(String(b.authorId)))
            return true;
        const s = (b.series || '').trim().toLowerCase();
        return !!s && sets.series.has(s);
    }

    tileSortRows(rows, sort) {
        const cmp =
            (sort === 'rate') ? ((a, b) => (b.librate - a.librate) || (a.insno - b.insno)) :
            (sort === 'year') ? ((a, b) => ((parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0)) || (b.insno - a.insno) || (b.id - a.id)) :
            (sort === 'serno') ? ((a, b) => this.sernoCmp(a, b)) :
            ((a, b) => (b.insno - a.insno) || (b.id - a.id));
        return rows.slice().sort(cmp);
    }

    //порядок книг внутри серии: с номером — по номеру, без номера — по дате поступления
    sernoCmp(a, b) {
        const sa = (a.serno > 0 ? a.serno : 0);
        const sb = (b.serno > 0 ? b.serno : 0);
        if (sa && sb)
            return (sa - sb) || (b.insno - a.insno) || (b.id - a.id);
        if (sa)
            return -1;
        if (sb)
            return 1;
        return (b.insno - a.insno) || (b.id - a.id);
    }

    //книги автора лентами по сериям: серии — по новому поступлению, внутри — по нумерации; без серии — в конце
    authorSeriesFeeds(books) {
        const bySeries = new Map();
        const noSeries = [];
        for (const book of books) {
            const s = (book.series || '').trim();
            if (!s) {
                noSeries.push(book);
                continue;
            }
            const key = s.toLowerCase();
            let g = bySeries.get(key);
            if (!g) {
                g = {series: s, maxInsno: 0, books: []};
                bySeries.set(key, g);
            }
            if (book.insno > g.maxInsno)
                g.maxInsno = book.insno;
            g.books.push(book);
        }
        for (const g of bySeries.values())
            g.books.sort((a, b) => this.sernoCmp(a, b));
        const feeds = Array.from(bySeries.values())
            .sort((a, b) => (b.maxInsno - a.maxInsno) || a.series.localeCompare(b.series, 'ru'));
        noSeries.sort((a, b) => (b.insno - a.insno) || (b.id - a.id));
        return {feeds, noSeries};
    }

    //лёгкий список книг серии для блока серии на странице книги: по нумерации, без номера — по поступлению
    lightSeriesBooks(books) {
        return books
            .filter((b) => !b.del)
            .sort((a, b) => this.sernoCmp(a, b))
            .map((b) => ({uid: b._uid, title: b.title, serno: (b.serno || 0), year: (b.year || '')}));
    }

    async getTileSection(params) {
        this.checkMyState();

        const type = params.type;
        const value = params.value;
        const profile = params.profile;
        const offset = parseInt(params.offset, 10) || 0;
        let limit = parseInt(params.limit, 10) || 50;
        if (limit > 500)
            limit = 500;
        const sort = ['new', 'rate', 'year', 'serno', 'series'].indexOf(params.sort) >= 0 ? params.sort : 'new';

        const db = this.db;
        let books = [];
        let total = 0;
        const meta = {type, value};

        //профиль: игнор книг/авторов/серий (прямой переход по поиску остаётся)
        let ud = null;
        if (profile) {
            const user = new UserData(this.config);
            ud = await user.getData(profile);
        }
        const sets = ud ? this.tileIgnoredSets(ud) : null;
        const applyIgnore = async(rows) => {
            if (!sets || !rows.length)
                return rows;
            await this.addAuthorIds(rows);
            return rows.filter((b) => !this.tileBookIgnored(sets, b));
        };

        if (type === 'genre') {
            const ids = await this.dbSearcher.sortedBookIds({genre: value}, (sort === 'rate' ? 'rate' : 'new'));
            total = ids.length;
            const slice = Array.from(ids.slice(offset, offset + limit));
            if (slice.length)
                books = await db.select({table: 'book', where: `@@id(${db.esc(slice)})`});
            if (sets && books.length) {
                //фильтр по странице: total при игноре приблизительный
                books = await applyIgnore(books);
            }
        } else if (type === 'author') {
            //клиент передаёт id автора (строка), если не число — имя
            const authorId = /^\d+$/.test(value) ? parseInt(value, 10) : '';
            const res = await this.dbSearcher.getAuthorBookList(authorId, authorId ? '' : value);
            meta.author = res.author;
            if (res.author) {
                const normalized = res.author.split(/\s+/).filter(Boolean).join(' ').toLowerCase().trim();
                meta.authorHash = utils.getBufHash(Buffer.from(normalized, 'utf8'), 'md5', 'hex');
            }

            if (sort === 'series') {
                //ленты серий без пагинации
                const {feeds, noSeries} = this.authorSeriesFeeds(res.books);
                total = res.books.length;
                meta.seriesFeeds = feeds.map((f) => ({series: f.series, count: f.books.length, books: f.books}));
                meta.noSeries = noSeries;
                //авторские id проставим на все книги лент (сами ленты уже в meta)
                const allFeedBooks = [];
                for (const f of meta.seriesFeeds)
                    allFeedBooks.push(...f.books);
                allFeedBooks.push(...noSeries);
                await this.addAuthorIds(allFeedBooks);

                if (sets) {
                    //исключаем ленты и книги под игнором
                    meta.seriesFeeds = meta.seriesFeeds
                        .filter((f) => !sets.series.has((f.series || '').toLowerCase()))
                        .map((f) => ({...f, books: f.books.filter((b) => !this.tileBookIgnored(sets, b))}))
                        .filter((f) => f.books.length);
                    meta.noSeries = noSeries.filter((b) => !this.tileBookIgnored(sets, b));
                }
            } else {
                books = this.tileSortRows(res.books, sort);
                if (sets)
                    books = await applyIgnore(books);
                total = books.length;
                books = books.slice(offset, offset + limit);
            }
        } else if (type === 'series') {
            const res = await this.dbSearcher.getSeriesBookList(value);
            books = this.tileSortRows(res.books, (sort === 'new' || sort === 'rate' || sort === 'year' ? sort : 'serno'));
            if (sets)
                books = await applyIgnore(books);
            total = books.length;
            books = books.slice(offset, offset + limit);
        } else if (type === 'year') {
            const {pools} = await this.getTilePools();
            const arr = pools.years[value] || [];
            if (sets) {
                const filtered = await applyIgnore(arr);
                books = filtered.slice(offset, offset + limit);
                total = filtered.length;
            } else {
                books = arr.slice(offset, offset + limit);
                total = arr.length;
            }
        } else {
            throw new Error(`unknown section type: ${type}`);
        }

        await this.addAuthorIds(books);
        return Object.assign({books, total}, meta);
    }

    async getTileBook(bookUid, profile) {
        this.checkMyState();

        const book = await this.getBookRecord(bookUid);
        if (!book)
            throw new Error('404 Book not found');

        await this.addAuthorIds([book]);
        const covers = await this.getBookCovers([bookUid]);

        const result = {book, cover: (covers[bookUid] || '')};
        const series = (book.series || '').trim();
        if (series) {
            const res = await this.dbSearcher.getSeriesBookList(series);
            result.seriesBooks = this.lightSeriesBooks(res.books);
        }

        if (profile) {
            const user = new UserData(this.config);
            const ud = await user.getData(profile);
            if (ud)
                result.user = {
                    read: !!ud.read[bookUid],
                    rating: (parseInt(ud.ratings[bookUid], 10) || 0),
                    review: (ud.reviews[bookUid] || ''),
                };
        }

        return result;
    }

    //профили пользователя (без авторизации)
    async listUserProfiles() {
        this.checkMyState();

        const user = new UserData(this.config);
        return {profiles: await user.listProfiles()};
    }

    async getUserData(profile) {
        this.checkMyState();

        const user = new UserData(this.config);
        const d = await user.getData(profile);
        return {profile, data: d};
    }

    async setUserRating(profile, bookUid, rate) {
        this.checkMyState();

        const user = new UserData(this.config);
        return await user.setRating(profile, bookUid, rate);
    }

    async setUserReview(profile, bookUid, text) {
        this.checkMyState();

        const user = new UserData(this.config);
        return await user.setReview(profile, bookUid, text);
    }

    async toggleRead(profile, bookUid) {
        this.checkMyState();

        const user = new UserData(this.config);
        return await user.toggleRead(profile, bookUid);
    }

    async ignoreItem(profile, kind, value, meta) {
        this.checkMyState();

        const user = new UserData(this.config);
        return await user.ignoreItem(profile, kind, value, meta);
    }

    async removeIgnore(profile, kind, key) {
        this.checkMyState();

        const user = new UserData(this.config);
        return await user.removeIgnore(profile, kind, key);
    }

    async toggleFeed(profile, feedId) {
        this.checkMyState();

        const user = new UserData(this.config);
        return await user.toggleFeed(profile, feedId);
    }

    async getBookCovers(bookUids) {
        this.checkMyState();

        const db = this.db;
        const result = {};

        const rows = await db.select({table: 'book', where: `@@hash('_uid', ${db.esc(bookUids)})`});
        if (!rows.length)
            return result;

        const config = this.config;
        //в root bookDir с расширением: подпапку /cover удаляет middleware восстановления /book/:fileName
        const coverDir = config.bookDir;

        //группируем книги по архиву обложек
        const byPath = new Map();
        for (const book of rows) {
            const coverPath = path.join(config.libDir, 'covers', book.folder);
            let arr = byPath.get(coverPath);
            if (!arr) {
                arr = [];
                byPath.set(coverPath, arr);
            }
            arr.push(book);
        }

        const pathQueue = Array.from(byPath.entries());

        const worker = async() => {
            while (pathQueue.length) {
                const [coverPath, books] = pathQueue.shift();
                if (!await fs.pathExists(coverPath))
                    continue;

                const zipReader = new ZipReader();
                try {
                    await zipReader.open(coverPath);

                    for (const book of books) {
                        const key = `${book.folder}/${book.file}`;
                        const hash = crypto.createHash('md5').update(key).digest('hex');

                        let link = '';
                        for (const ext of ['jpg', 'png']) {
                            if (await fs.pathExists(path.join(coverDir, `${hash}.${ext}`))) {
                                link = `${config.bookPathStatic}/${hash}.${ext}`;
                                break;
                            }
                        }

                        if (!link && (book.file in zipReader.zipEntries)) {
                            const coverBuff = await zipReader.extractToBuf(book.file);
                            if (coverBuff) {
                                const {outputImg, ext} = await jxlConvert(coverBuff);
                                if (outputImg.length) {
                                    const fileExt = (ext === 'jpeg' ? 'jpg' : ext);
                                    await fs.writeFile(path.join(coverDir, `${hash}.${fileExt}`), outputImg);
                                    link = `${config.bookPathStatic}/${hash}.${fileExt}`;
                                }
                            }
                        }
                        if (link)
                            result[book._uid] = link;
                    }
                } catch (e) {
                    //битый архив обложек — пропускаем
                    log(LM_ERR, `getBookCovers error: ${e.message}`);
                } finally {
                    try { await zipReader.close(); } catch (e) {}
                }
            }
        };

        const workers = [];
        for (let i = 0; i < 8; i++)
            workers.push(worker());
        await Promise.all(workers);

        return result;
    }

    async extractBook(libFolder, libFile) {
        const outFile = `${this.config.tempDir}/${utils.randomHexString(30)}`;

        libFolder = libFolder.replace(/\\/g, '/').replace(/\/\//g, '/');

        const folder = `${this.config.libDir}/${libFolder}`;
        const file = libFile;
        
        const fullPath = `${folder}/${file}`;

        if (!file || await fs.pathExists(fullPath)) {// файл есть на диске
            
            await fs.copy(fullPath, outFile);
            return outFile;
        } else {
          // файл в zip-архиве
          if (await fs.pathExists(folder)) {
            // файл в zip-архиве
            const zipReader = new ZipReader();
            await zipReader.open(folder);

            try {
              await zipReader.extractToFile(file, outFile);

              if (!(await fs.pathExists(outFile))) {
                //не удалось найти в архиве, попробуем имя файла в кодировке cp866
                await zipReader.extractToFile(
                  iconv.encode(file, "cp866").toString(),
                  outFile,
                );
              }

              return outFile;
            } finally {
              await zipReader.close();
            }
          } else {
            const folder7z = folder.replace(".zip", ".7z");
            if (await fs.pathExists(folder7z)) {
              await BookAppendImages(this.config, libFolder, file, outFile);
              return outFile;
            }
          }
        }
    }

    // Принимает hash уже материализованного файла (bookDir/<hash>).
    // Материализация (включая remote lib: downloadBook) — в getBookLink/restoreBook, НЕ здесь.
    // fileType: undefined | 'raw' | 'zip'. ext-<key> НЕ поддерживается (это ветка static.js).
    async resolveBookFile(hash, fileType) {
        this.checkMyState();

        const bookFile = path.join(this.config.bookDir, hash);
        const bookFileDesc = `${bookFile}.d.json`;

        if (!await fs.pathExists(bookFile) || !await fs.pathExists(bookFileDesc))
            throw new Error('404 Файл не найден');

        const desc = JSON.parse(await fs.readFile(bookFileDesc, 'utf8'));
        const bookExt = path.extname(desc.libFile || desc.downFileName || '').toLowerCase();
        const isGzipStored = (bookExt !== '.epub');

        if (fileType === 'zip') {
            const zipFile = `${bookFile}.zip`;
            if (!await fs.pathExists(zipFile)) {
                const rawSrc = isGzipStored
                    ? await this._ensureRaw(bookFile)
                    : bookFile;
                await utils.generateZip(zipFile, rawSrc, desc.downFileName);
            }
            return { path: zipFile, filename: `${desc.downFileName}.zip`, mime: 'application/zip', gzipped: false };
        }

        if (!isGzipStored)
            return { path: bookFile, filename: desc.downFileName, mime: bookContentType(desc.downFileName), gzipped: false };

        // fb2 (gzip)
        if (fileType === 'raw') {
            const rawFile = await this._ensureRaw(bookFile);
            return { path: rawFile, filename: desc.downFileName, mime: bookContentType(desc.downFileName), gzipped: false };
        }

        // fileType undefined — отдать gzip как есть (клиент с Accept-Encoding: gzip)
        return { path: bookFile, filename: desc.downFileName, mime: bookContentType(desc.downFileName), gzipped: true };
    }

    async _ensureRaw(bookFile) {
        const rawFile = `${bookFile}.raw`;
        if (!await fs.pathExists(rawFile))
            await utils.gunzipFile(bookFile, rawFile);
        return rawFile;
    }

    //одинаковые параллельные запросы (get-book-reviews + get-book-info) должны ждать одну операцию,
    //иначе два 7z извлекут один и тот же файл и второй получит "Cannot delete output file"
    async restoreBook(bookUid, libFolder, libFile, downFileName) {
        let p = this._restoring.get(bookUid);
        if (!p) {
            p = this._restoreBook(bookUid, libFolder, libFile, downFileName);
            this._restoring.set(bookUid, p);
            p.catch(() => {}).finally(() => this._restoring.delete(bookUid));
        }

        return p;
    }

    async _restoreBook(bookUid, libFolder, libFile, downFileName) {
        const db = this.db;

        let extractedFile = '';
        let hash = '';

        if (!this.remoteLib) {
            extractedFile = await this.extractBook(libFolder, libFile);
            hash = await utils.getFileHash(extractedFile, 'sha256', 'hex');
        } else {
            hash = await this.remoteLib.downloadBook(bookUid);
        }

        const link = `${this.config.bookPathStatic}/${hash}`;
        const bookFile = `${this.config.bookDir}/${hash}`;
        const bookFileDesc = `${bookFile}.d.json`;

        if (!await fs.pathExists(bookFile) || !await fs.pathExists(bookFileDesc)) {
            if (!await fs.pathExists(bookFile) && extractedFile) {
                const ext = path.extname(libFile).toLowerCase();
                if (ext === '.epub') {
                    // epub уже сжат (zip) — gzip не даёт выигрыша, кладём как есть
                    await fs.move(extractedFile, bookFile, {overwrite: true});
                } else {
                    const tmpFile = `${this.config.tempDir}/${utils.randomHexString(30)}`;
                    await utils.gzipFile(extractedFile, tmpFile, 4);
                    await fs.remove(extractedFile);
                    await fs.move(tmpFile, bookFile, {overwrite: true});
                }
            } else {
                await utils.touchFile(bookFile);
            }

            await fs.writeFile(bookFileDesc, JSON.stringify({bookUid, libFolder, libFile, downFileName}));
        } else {
            if (extractedFile)
                await fs.remove(extractedFile);

            await utils.touchFile(bookFile);
            await utils.touchFile(bookFileDesc);
        }

        await db.insert({
            table: 'file_hash',
            replace: true,
            rows: [
                {id: bookUid, hash},
            ]
        });

        return link;
    }

    //в .d.json, созданных до появления полки, нет bookUid: по нему статика узнает, что скачали
    async updateBookFileDesc(bookFileDesc, bookUid) {
        try {
            const desc = JSON.parse(await fs.readFile(bookFileDesc, 'utf8'));
            if (desc.bookUid !== bookUid) {
                desc.bookUid = bookUid;
                await fs.writeFile(bookFileDesc, JSON.stringify(desc));
            }
        } catch (e) {
            log(LM_ERR, `updateBookFileDesc error: ${e.message}`);
        }
    }

    async getBookRecord(bookUid) {
        this.checkMyState();

        const db = this.db;
        const rows = await db.select({table: 'book', where: `@@hash('_uid', ${db.esc(bookUid)})`});
        return (rows.length ? rows[0] : null);
    }

    async getBooks(uids) {
        this.checkMyState();
        if (!uids || !uids.length)
            return [];
        return await this.db.select({
            table: 'book',
            where: `@@hash('_uid', ${this.db.esc(Array.from(uids))})`,
        });
    }

    //для файлов, попавших в кеш до появления полки, bookUid в .d.json нет — ищем по хешу
    async getBookUidByHash(hash) {
        this.checkMyState();

        const rows = await this.db.select({table: 'file_hash'});
        const found = rows.find(r => r.hash === hash);
        return (found ? found.id : '');
    }

    async getBookLink(bookUid) {
        this.checkMyState();

        try {
            const db = this.db;
            let link = '';

            //найдем downFileName, libFolder, libFile
            let rows = await db.select({table: 'book', where: `@@hash('_uid', ${db.esc(bookUid)})`});
            if (!rows.length)
                throw new Error('404 Файл не найден');

            const book = rows[0];
            let downFileName = book.file;
            const authors = book.author.split(',');
            let author = authors[0];
            author = author.split(' ').filter(r => r.trim());
            for (let i = 1; i < author.length; i++)
                author[i] = `${(i === 1 ? ' ' : '')}${author[i][0]}.`;
            if (authors.length > 1)
                author.push(' и др.');

            const at = [author.join(''), (book.title ? `_${book.title}` : '')];
            downFileName = utils.makeValidFileNameOrEmpty(at.filter(r => r).join(''))
                || utils.makeValidFileNameOrEmpty(at[0])
                || utils.makeValidFileNameOrEmpty(at[1])
                || downFileName;
            if (downFileName.length > 50)
                downFileName = `${downFileName.substring(0, 50)}_`;

            const ext = `.${book.ext}`;
            if (downFileName.substring(downFileName.length - ext.length) != ext)
                downFileName += ext;

            const libFolder = book.folder;
            const libFile = `${book.file}${ext}`;

            //найдем хеш
            rows = await db.select({table: 'file_hash', where: `@@id(${db.esc(bookUid)})`});
            if (rows.length) {//хеш найден по bookUid
                const hash = rows[0].hash;
                const bookFile = `${this.config.bookDir}/${hash}`;
                const bookFileDesc = `${bookFile}.d.json`;

                if (await fs.pathExists(bookFile) && await fs.pathExists(bookFileDesc)) {
                    link = `${this.config.bookPathStatic}/${hash}`;
                    await this.updateBookFileDesc(bookFileDesc, bookUid);
                }
            }

            if (!link) {
                link = await this.restoreBook(bookUid, libFolder, libFile, downFileName);
            }

            if (!link)
                throw new Error('404 Файл не найден');

            return {link, libFolder, libFile, downFileName};
        } catch(e) {
            log(LM_ERR, `getBookLink error: ${e.message}`);
            if (e.message.indexOf('ENOENT') >= 0)
                throw new Error('404 Файл не найден');
            throw e;
        }
    }

    async getBookInfo(bookUid) {
        this.checkMyState();

        try {
            const db = this.db;

            let bookInfo = await this.getBookLink(bookUid);
            const hash = path.basename(bookInfo.link);
            const bookFile = `${this.config.bookDir}/${hash}`;
            const bookFileInfo = `${bookFile}.i.json`;

            let rows = await db.select({table: 'book', where: `@@hash('_uid', ${db.esc(bookUid)})`});
            if (!rows.length)
                throw new Error('404 Файл не найден');
            const book = rows[0];

            const restoreBookInfo = async(info) => {
                const result = {};

                result.book = book;
                result.cover = '';
                result.bookInfo = null;
                let parser = null;

                const {libFolder, libFile} = bookInfo;

                if (book.ext == 'fb2') {
                    const data = await extractFb2Data(bookFile, this.config, libFolder, libFile.slice(0, -4), this.fb2Helper);
                    parser = data.fb2;
                    result.bookInfo = data.fb2 ? data.fb2.bookInfo() : null;

                    if (data.cover) {
                        result.cover = `${this.config.bookPathStatic}/${hash}${data.coverExt}`;
                        await fs.writeFile(`${bookFile}${data.coverExt}`, data.cover);
                    }
                } else if (book.ext === 'epub') {
                    const data = await extractEpubData(bookFile, this.config, libFolder, libFile.slice(0, -4), this.epubHelper);
                    result.bookInfo = data.bookInfo;

                    if (data.cover) {
                        result.cover = `${this.config.bookPathStatic}/${hash}${data.coverExt}`;
                        result.coverType = data.coverExt === '.png' ? 'image/png' : 'image/jpeg';
                        await fs.writeFile(`${bookFile}${data.coverExt}`, data.cover);
                    }
                }

                Object.assign(info, result);

                await fs.writeFile(bookFileInfo, JSON.stringify(info));

                if (this.config.branch === 'development') {
                    await fs.writeFile(`${bookFile}.dev`, `${JSON.stringify(info, null, 2)}\n\n${parser ? parser.toString({format: true}) : ''}`);
                }
            };

            if (!await fs.pathExists(bookFileInfo)) {
                await restoreBookInfo(bookInfo);
            } else {
                await utils.touchFile(bookFileInfo);
                const info = await fs.readFile(bookFileInfo, 'utf-8');
                const tmpInfo = JSON.parse(info);

                //проверим существование файла обложки, восстановим если нету
                let coverFile = '';
                if (tmpInfo.cover)
                    coverFile = `${this.config.publicFilesDir}${tmpInfo.cover}`;

                if (book.id != tmpInfo.book.id || (coverFile && !await fs.pathExists(coverFile))
                    || !tmpInfo.bookInfo) {
                    await restoreBookInfo(bookInfo);
                } else {
                    bookInfo = tmpInfo;
                }
            }

            return {bookInfo};
        } catch(e) {
            log(LM_ERR, `getBookInfo error: ${e.message}`);
            if (e.message.indexOf('ENOENT') >= 0)
                throw new Error('404 Файл не найден');
            throw e;
        }
    }
    
    async materializeReviews(bookUid) {
        this.checkMyState();
        if (!this.reviewsReader)
            throw new Error('reviews_disabled');

        const bookRows = await this.db.select({table: 'book', where: `@@hash('_uid', ${this.db.esc(bookUid)})`});
        if (!bookRows.length)
            throw new Error('404 Книга не найдена');
        const book = bookRows[0];
        const folder = book.folder;
        const file = `${book.file}.${book.ext}`;

        let hash = '';
        const fhRows = await this.db.select({table: 'file_hash', where: `@@id(${this.db.esc(bookUid)})`});
        if (fhRows.length)
            hash = fhRows[0].hash;

        if (this.remoteLib) {
            const reviewFile = hash ? `${this.config.bookDir}/${hash}.review` : '';
            if (!hash || !await fs.pathExists(reviewFile))
                hash = await this.remoteLib.downloadReview(bookUid);
        } else if (!hash) {
            const bookInfo = await this.getBookLink(bookUid);
            hash = path.basename(bookInfo.link);
        }

        const result = await this.reviewsReader.read(folder, file, hash);
        return {hash, result};
    }

    async getBookReviews(bookUid) {
        const {result} = await this.materializeReviews(bookUid);
        return result;
    }

    async getReviewLink(bookUid) {
        const {hash} = await this.materializeReviews(bookUid);
        const cacheFile = `${this.config.bookDir}/${hash}.review`;
        if (!await fs.pathExists(cacheFile))
            throw new Error('404 Рецензии не найдены');
        return {link: `${this.config.bookPathStatic}/${hash}.review`};
    }

    async getBookReviewsCount(bookUid) {
        this.checkMyState();

        if (!this.reviewsReader)
            throw new Error('reviews_disabled');

        const bookRows = await this.db.select({
            table: 'book',
            where: `@@hash('_uid', ${this.db.esc(bookUid)})`,
        });

        if (!bookRows.length)
            throw new Error('404 Книга не найдена');

        const book = bookRows[0];
        const folder = book.folder;
        const file = `${book.file}.${book.ext}`;

        return await this.reviewsReader.getCount(folder, file);
    }

    async getBookAuthors(bookUid) {
        this.checkMyState();

        if (!this.authorBioReader)
            throw new Error('authors_disabled');

        const bookRows = await this.db.select({
            table: 'book',
            where: `@@hash('_uid', ${this.db.esc(bookUid)})`,
        });

        if (!bookRows.length)
            throw new Error('404 Книга не найдена');

        const book = bookRows[0];
        if (!book.author)
            return [];

        // author — строка вида "Фамилия Имя Отчество,Фамилия2 Имя2"
        const names = book.author.split(',').map(a => a.trim()).filter(a => a);

        const result = [];
        for (const name of names) {
            const normalized = name.split(/\s+/).filter(Boolean).join(' ').toLowerCase().trim();
            const hash = utils.getBufHash(Buffer.from(normalized, 'utf8'), 'md5', 'hex');

            const archiveId = await this.authorBioReader.getArchiveId(hash);

            result.push({
                name,
                hash,
                found: archiveId !== null,
            });
        }

        return result;
    }

    // материализует <hash>.bio и <hash>.<ext> (или <hash>.nophoto);
    // потребитель скачивает у поставщика.
    // getBio вызывается первым: он инвалидирует невалидный кэш (сносит .bio, фото, .nophoto)
    // до downloadBio/downloadPhoto, иначе можно снести только что скачанное.
    async materializeBio(hash) {
        this.checkMyState();

        if (!this.authorBioReader)
            throw new Error('authors_disabled');

        // инвалидация + кэш: getBio сам снесёт невалидный кэш (включая фото/.nophoto)
        let bio = await this.authorBioReader.getBio(hash).catch(() => null);

        if (this.remoteLib) {
            const bioFile = `${this.config.authorDir}/${hash}.bio`;
            if (bio === null && !await fs.pathExists(bioFile)) {
                try { await this.remoteLib.downloadBio(hash); } catch (e) {}
            }

            const photoCached = await this.authorBioReader._findCachedPhoto(hash);
            const noPhoto = await fs.pathExists(`${this.config.authorDir}/${hash}.nophoto`);
            if (!photoCached && !noPhoto) {
                try { await this.remoteLib.downloadPhoto(hash); } catch (e) {}
            }
        }

        if (bio === null)
            bio = await this.authorBioReader.getBio(hash).catch(() => null);
        const photo = await this.authorBioReader.getPhoto(hash).catch(() => null);

        return {hash, bio, photo};
    }

    async getAuthorBio(hash) {
        const {bio, photo} = await this.materializeBio(hash);
        return {bio, hasPhoto: !!photo};
    }

    async getAuthorPhoto(hash) {
        const {photo} = await this.materializeBio(hash);
        return photo;
    }

    // поставщик: материализует <hash>.bio и возвращает ссылку
    async getBioLink(hash) {
        this.checkMyState();
        if (!this.authorBioReader)
            throw new Error('authors_disabled');

        const bio = await this.authorBioReader.getBio(hash);
        if (bio === null)
            throw new Error('404 Биография не найдена');

        return {link: `${this.config.rootPathStatic}/author/${hash}.bio`};
    }

    // поставщик: материализует <hash>.<ext> (или <hash>.nophoto) и возвращает ссылку
    async getPhotoLink(hash) {
        this.checkMyState();
        if (!this.authorBioReader)
            throw new Error('authors_disabled');

        const photo = await this.authorBioReader.getPhoto(hash);
        if (photo)
            return {link: `${this.config.rootPathStatic}/author/${hash}${photo.ext}`};

        // фото нет — getPhoto создал <hash>.nophoto; отдаём маркер
        return {link: `${this.config.rootPathStatic}/author/${hash}.nophoto`};
    }

    getAuthorPhotoMime(ext) {
        if (!this.authorBioReader)
            return 'application/octet-stream';
        return this.authorBioReader.mimeFromExt(ext);
    }

    async getFavorites(offset = 0, limit = 50) {
        this.checkMyState();

        const favorites = new Favorites(this.config);
        const favList = await favorites.list();

        const total = favList.length;
        const slice = (limit === 0)
            ? favList.slice(offset)
            : favList.slice(offset, offset + limit);

        if (!slice.length)
            return {books: [], total};

        const uids = slice.map(f => f.uid);
        const bookRows = await this.db.select({
            table: 'book',
            where: `@@hash('_uid', ${this.db.esc(uids)})`,
        });

        const bookMap = new Map();
        for (const row of bookRows)
            bookMap.set(row._uid, row);

        const books = [];
        for (const fav of slice) {
            const book = bookMap.get(fav.uid);
            if (book)
                books.push(Object.assign({}, fav, book));
            else
                books.push(Object.assign({}, fav, {deleted: true}));
        }

        return {books, total};
    }

    async getFavoriteUids() {
        this.checkMyState();

        const favorites = new Favorites(this.config);
        const favList = await favorites.list();

        return {uids: favList.map(f => f.uid)};
    }

    async addFavorite(bookUid) {
        this.checkMyState();

        const bookRows = await this.db.select({
            table: 'book',
            where: `@@hash('_uid', ${this.db.esc(bookUid)})`,
        });

        if (!bookRows.length)
            throw new Error('404 Книга не найдена');

        const favorites = new Favorites(this.config);
        await favorites.add(bookUid, bookRows[0]);
    }

    async removeFavorite(bookUid) {
        this.checkMyState();

        const favorites = new Favorites(this.config);
        await favorites.remove(bookUid);
    }

    async dumpIndex(table) {
        this.checkMyState();
        if (!this.db)
            throw new Error('db_not_ready');

        const dbConfig = await this.dbConfig();
        const stats = (dbConfig && dbConfig.stats) || {};
        if (table === 'reviews_index' && !stats.reviewsEnabled)
            return {data: null, hash: null};
        if (table === 'authors_info' && !stats.authorsBioEnabled)
            return {data: null, hash: null};

        const db = this.db;
        if (!db.wwCache.indexDumps)
            db.wwCache.indexDumps = {};
        const cached = db.wwCache.indexDumps[table];

        // кэш hash/буфера: сбрасывается вместе с db при пересоздании БД
        if (cached)
            return {data: cached.buf, hash: cached.hash};
        const rows = await db.select({table});
        const cols = {};
        for (const key of Object.keys(rows[0] || {}))
            cols[key] = rows.map(r => r[key]);
        const json = JSON.stringify(cols);
        const buf = zlib.gzipSync(Buffer.from(json, 'utf8'));
        const hash = crypto.createHash('sha256').update(buf).digest('hex');

        db.wwCache.indexDumps[table] = {buf, hash};

        return {data: buf, hash};
    }

    async getInpxFile(params) {
        let data = null;
        if (params.inpxFileHash && this.inpxFileHash && params.inpxFileHash === this.inpxFileHash) {
            data = false;
        }

        if (data === null)
            data = await fs.readFile(this.config.inpxFile, 'base64');

        return {data};
    }

    logServerStats() {
        try {
            const memUsage = process.memoryUsage();
            const rss = (memUsage.rss / 1024 / 1024).toFixed(2);
            const heapUsed = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
            const heapTotal = (memUsage.heapTotal / 1024 / 1024).toFixed(2);
            const external = (memUsage.external / 1024 / 1024).toFixed(2);
            let loadAvg = os.loadavg();
            loadAvg = loadAvg.map(v => v.toFixed(2));
            log(`Server stats [ TotalMem: ${rss}MB, heapUsed: ${heapUsed}MB, heapTotal: ${heapTotal}MB, external: ${external}MB, loadAvg: (${loadAvg.join(', ')}) ]`);
        } catch (e) {
            log(LM_ERR, e.message);
        }
    }
    
    async periodicLogServerStats() {
        if (!this.config.logServerStats)
            return;

        while (1) {// eslint-disable-line
            this.logServerStats();
            await utils.sleep(60*1000);
        }
    }

    async cleanDir(config) {
        const {dir, maxSize} = config;

        const list = await fs.readdir(dir);

        let size = 0;
        let files = [];
        //формируем список
        for (const filename of list) {
            const filePath = `${dir}/${filename}`;
            const stat = await fs.stat(filePath);
            if (!stat.isDirectory()) {
                size += stat.size;
                files.push({name: filePath, stat});
            }
        }

        files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

        let i = 0;
        //удаляем
        while (i < files.length && size > maxSize) {
            const file = files[i];
            const oldFile = file.name;
            await fs.remove(oldFile);
            size -= file.stat.size;
            i++;
        }

        if (i) {
            log(LM_WARN, `clean dir ${dir}, maxSize=${maxSize}, found ${files.length} files, total size=${size}`);
            log(LM_WARN, `removed ${i} files`);
        }
    }

    async periodicCleanDir(dirConfig) {
        try {
            for (const config of dirConfig) 
                await fs.ensureDir(config.dir);

            let lastCleanDirTime = 0;
            while (1) {// eslint-disable-line no-constant-condition
                //чистка папок
                if (Date.now() - lastCleanDirTime >= cleanDirInterval) {
                    for (const config of dirConfig) {
                        try {
                            await this.cleanDir(config);
                        } catch(e) {
                            log(LM_ERR, e.stack);
                        }
                    }

                    lastCleanDirTime = Date.now();
                }

                await utils.sleep(60*1000);//интервал проверки 1 минута
            }
        } catch (e) {
            log(LM_FATAL, e.message);
            asyncExit.exit(1);
        }
    }

    async periodicCheckInpx() {
        const inpxCheckInterval = this.config.inpxCheckInterval;
        if (!inpxCheckInterval)
            return;

        while (1) {// eslint-disable-line no-constant-condition
            try {
                while (this.myState != ssNormal)
                    await utils.sleep(1000);

                if (this.remoteLib) {
                    await this.remoteLib.downloadInpxFile();
                }

                const newInpxHash = await this.inpxHashCreator.getHash();

                const dbConfig = await this.dbConfig();
                const currentInpxHash = (dbConfig.inpxHash ? dbConfig.inpxHash : '');

                if (newInpxHash !== currentInpxHash) {
                    log('inpx file: changes found, recreating DB');
                    await this.recreateDb();
                } else {
                    //log('inpx file: no changes');
                }
            } catch(e) {
                log(LM_ERR, `periodicCheckInpx: ${e.message}`);
            }

            await utils.sleep(inpxCheckInterval*60*1000);
        }
    }

    async periodicCheckNewRelease() {
        const checkReleaseLink = this.config.checkReleaseLink;
        if (!checkReleaseLink)
            return;
        const down = new FileDownloader(1024*1024);

        while (1) {// eslint-disable-line no-constant-condition
            try {
                let release = await down.load(checkReleaseLink);
                release = JSON.parse(release.toString());

                if (release.tag_name)
                    this.config.latestVersion = release.tag_name;
            } catch(e) {
                log(LM_ERR, `periodicCheckNewRelease: ${e.message}`);
            }

            await utils.sleep(checkReleaseInterval);
        }
    }
}

module.exports = WebWorker;