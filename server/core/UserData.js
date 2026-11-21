const fs = require('fs-extra');
const path = require('path');

const LockQueue = require('./LockQueue');

//Данные пользователя без авторизации: профиль — любой текст, под которым хранятся
//оценки, отзывы, прочитанные книги, игнор и отключённые ленты.
//Каждый профиль — отдельный файл <dataDir>/userData/<profile>.json.
class UserData {
    constructor(config) {
        if (UserData.instance)
            return UserData.instance;

        this.config = config;
        this.dir = path.join(config.dataDir, 'userData');
        this.lock = new LockQueue(1000);
        this.cache = new Map(); //profile -> data

        UserData.instance = this;
    }

    static validProfile(name) {
        return (typeof name === 'string') && /^[A-Za-z0-9._-]{1,32}$/.test(name) && /[A-Za-z0-9]/.test(name);
    }

    emptyData() {
        return {
            read: {},           //uid -> время отметки
            ratings: {},        //uid -> целое 1..5
            reviews: {},        //uid -> текст отзыва
            ignored: {
                books: [],      //{uid, title, author, series}
                authors: [],    //{id, name}
                series: [],     //{name, count}
            },
            disabledFeeds: [],  //id лент
            progress: {},       //uid -> {section, total, frac, time} — прогресс читалки
        };
    }

    _normalize(d) {
        const e = this.emptyData();
        d = (d && typeof d === 'object') ? d : {};

        e.read = (d.read && typeof d.read === 'object') ? d.read : {};
        e.ratings = (d.ratings && typeof d.ratings === 'object') ? d.ratings : {};
        e.reviews = (d.reviews && typeof d.reviews === 'object') ? d.reviews : {};

        e.ignored.books = Array.isArray(d.ignored?.books) ? d.ignored.books : [];
        e.ignored.authors = Array.isArray(d.ignored?.authors) ? d.ignored.authors : [];
        e.ignored.series = Array.isArray(d.ignored?.series) ? d.ignored.series : [];
        e.disabledFeeds = Array.isArray(d.disabledFeeds) ? d.disabledFeeds : [];

        //битые записи прогресса отбрасываем, валидные приводим к единому виду
        if (d.progress && typeof d.progress === 'object') {
            for (const [uid, p] of Object.entries(d.progress)) {
                const section = parseInt(p?.section, 10);
                const total = parseInt(p?.total, 10);
                if (uid && !isNaN(section) && !isNaN(total) && section > 0 && total > 0) {
                    e.progress[uid] = {
                        section,
                        total,
                        frac: Math.max(0, Math.min(1, parseFloat(p.frac) || 0)),
                        time: (typeof p.time === 'string' ? p.time : ''),
                    };
                }
            }
        }

        return e;
    }

    async _load(profile) {
        let d = this.cache.get(profile);
        if (!d) {
            const file = path.join(this.dir, `${profile}.json`);
            d = this.emptyData();
            if (await fs.pathExists(file)) {
                try {
                    d = this._normalize(JSON.parse(await fs.readFile(file, 'utf8')));
                } catch (e) {
                    //битый файл не должен ронять сервер, начинаем профиль заново
                    d = this.emptyData();
                }
            }
            this.cache.set(profile, d);
        }
        return d;
    }

    async _save(profile, d) {
        await fs.ensureDir(this.dir);
        const file = path.join(this.dir, `${profile}.json`);
        const tmpFile = `${file}.tmp`;
        await fs.writeFile(tmpFile, JSON.stringify(d, null, 2));
        await fs.move(tmpFile, file, {overwrite: true});
    }

    async listProfiles() {
        if (!await fs.pathExists(this.dir))
            return [];

        const files = await fs.readdir(this.dir);
        return files
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5));
    }

    //чтение (без сохранения пустого профиля)
    async getData(profile) {
        if (!UserData.validProfile(profile))
            return null;

        await this.lock.get();
        try {
            return this._clone(await this._load(profile));
        } finally {
            this.lock.ret();
        }
    }

    _clone(d) {
        return JSON.parse(JSON.stringify(d));
    }

    //запись: mutator принимает данные профиля
    async _mutate(profile, mutator) {
        if (!UserData.validProfile(profile))
            throw new Error('invalid profile name');

        await this.lock.get();
        try {
            const d = await this._load(profile);
            const result = await mutator(d);
            await this._save(profile, d);
            return (result !== undefined ? result : this._clone(d));
        } finally {
            this.lock.ret();
        }
    }

    setRating(profile, bookUid, rate) {
        rate = parseInt(rate, 10);
        if (!bookUid || isNaN(rate))
            throw new Error('invalid rating');
        rate = Math.max(0, Math.min(5, rate)); //0 — снять оценку

        return this._mutate(profile, (d) => {
            if (rate === 0)
                delete d.ratings[bookUid];
            else
                d.ratings[bookUid] = rate;
            return {rating: rate};
        });
    }

    setReview(profile, bookUid, text) {
        if (!bookUid)
            throw new Error('invalid book uid');
        text = (typeof text === 'string' ? text : '').trim();
        if (text.length > 4000)
            throw new Error('review too long');

        return this._mutate(profile, (d) => {
            if (!text)
                delete d.reviews[bookUid];
            else
                d.reviews[bookUid] = text;
            return {review: text};
        });
    }

    toggleRead(profile, bookUid) {
        if (!bookUid)
            throw new Error('invalid book uid');

        return this._mutate(profile, (d) => {
            if (d.read[bookUid]) {
                delete d.read[bookUid];
                return {read: false};
            }
            d.read[bookUid] = (new Date()).toISOString();
            return {read: true};
        });
    }

    //kind: book|author|series
    async ignoreItem(profile, kind, value, meta = {}) {
        if (!['book', 'author', 'series'].includes(kind))
            throw new Error('invalid ignore kind');
        if (!value)
            throw new Error('invalid ignore value');

        const key =
            (kind === 'book') ? value :
            (kind === 'author') ? String(value) :
            String(value).toLowerCase();

        return this._mutate(profile, (d) => {
            const list =
                (kind === 'book') ? d.ignored.books :
                (kind === 'author') ? d.ignored.authors :
                d.ignored.series;

            const pred =
                (kind === 'book') ? (x) => x.uid === value :
                (kind === 'author') ? (x) => String(x.id) === key :
                (x) => x.name.toLowerCase() === key;

            if (list.some(pred))
                return {ignored: false};

            const rec =
                (kind === 'book') ? {uid: value, title: meta.title || '', author: meta.author || '', series: meta.series || ''} :
                (kind === 'author') ? {id: parseInt(key, 10) || key, name: meta.name || ''} :
                {name: String(value), count: (meta.count || 0)};
            list.push(rec);
            return {ignored: true};
        });
    }

    //kind: book|author|series, key: uid | authorId | series name
    removeIgnore(profile, kind, key) {
        if (!['book', 'author', 'series'].includes(kind))
            throw new Error('invalid ignore kind');
        if (!key)
            throw new Error('invalid ignore key');

        const k = (kind === 'series') ? String(key).toLowerCase() : String(key);

        return this._mutate(profile, (d) => {
            const list =
                (kind === 'book') ? d.ignored.books :
                (kind === 'author') ? d.ignored.authors :
                d.ignored.series;

            const pred =
                (kind === 'book') ? (x) => x.uid === k :
                (kind === 'author') ? (x) => String(x.id) === k :
                (x) => x.name.toLowerCase() === k;

            const before = list.length;
            list.splice(0, list.length, ...list.filter((x) => !pred(x)));
            return {removed: (list.length !== before)};
        });
    }

    //прогресс чтения: {section, total, frac} — читалка шлёт при выходе
    setProgress(profile, bookUid, p) {
        if (!bookUid)
            throw new Error('invalid book uid');

        p = (p && typeof p === 'object') ? p : {};
        const section = Math.max(1, parseInt(p.section, 10) || 1);
        const total = Math.max(1, parseInt(p.total, 10) || 1);
        const frac = Math.max(0, Math.min(1, parseFloat(p.frac) || 0));

        return this._mutate(profile, (d) => {
            d.progress[bookUid] = {section, total, frac, time: (new Date()).toISOString()};
            return {progress: d.progress[bookUid]};
        });
    }

    //feedId — id ленты: new, top, seriesNew, seriesTop, years, authors, genres,
    //или genre-new:<genres> / genre-best:<genres>
    toggleFeed(profile, feedId) {
        if (typeof feedId !== 'string' || !feedId || feedId.length > 500)
            throw new Error('invalid feed id');

        return this._mutate(profile, (d) => {
            const i = d.disabledFeeds.indexOf(feedId);
            if (i >= 0) {
                d.disabledFeeds.splice(i, 1);
                return {disabled: false};
            }
            d.disabledFeeds.push(feedId);
            return {disabled: true};
        });
    }
}

module.exports = UserData;
