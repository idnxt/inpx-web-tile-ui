const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('path');
const WebWorker = require('../../server/core/WebWorker');
const FakeDb = require('../helpers/fakeDb');
const { makeTmpDir, cleanup } = require('../helpers/tmpdir');
const { resetSingletons } = require('../helpers/instances');

// fakeThis: без конструктора (singleton + фоновые циклы).
function makeFakeThis(opts = {}) {
    const db = new FakeDb();
    db.tables.set('book', [
        {id: 1, _uid: 'uid-a', title: 'Книга A', author: 'Автор А', authorId: 11, year: '2020', ext: 'fb2'},
        {id: 2, _uid: 'uid-b', title: 'Книга B', author: 'Автор Б', authorId: 12, year: '2021', ext: 'fb2'},
        {id: 3, _uid: 'uid-c', title: 'Книга C', author: 'Автор В', authorId: 13, year: '2022', ext: 'fb2'},
    ]);

    return {
        config: {dataDir: opts.dataDir},
        db,
        checkMyState() {},
        getBooks: WebWorker.prototype.getBooks,
        //authorId уже есть в строках
        async addAuthorIds() {},
    };
}

async function writeUserData(dataDir, profile, data) {
    await fs.ensureDir(path.join(dataDir, 'userData'));
    await fs.writeFile(path.join(dataDir, 'userData', `${profile}.json`), JSON.stringify(data));
}

test('getTileReadList: по убыванию времени, readTime, неизвестные uid отбрасываются', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const fake = makeFakeThis({dataDir: dir});
        await writeUserData(dir, 'p1', {
            read: {'uid-b': '2026-01-02', 'uid-a': '2026-01-01', 'uid-x': '2026-01-03'},
            ratings: {},
        });

        const res = await WebWorker.prototype.getTileReadList.call(fake, 'p1', 0, 50);
        assert.strictEqual(res.total, 3);
        assert.strictEqual(res.books.length, 2);
        assert.strictEqual(res.books[0]._uid, 'uid-b');
        assert.strictEqual(res.books[0].readTime, '2026-01-02');
        assert.strictEqual(res.books[1]._uid, 'uid-a');
        assert.strictEqual(res.books[1].authorId, 11);

        //пагинация: uid-x удалён, на второй странице uid-a
        const res2 = await WebWorker.prototype.getTileReadList.call(fake, 'p1', 2, 50);
        assert.strictEqual(res2.total, 3);
        assert.deepStrictEqual(res2.books.map((b) => b._uid), ['uid-a']);

        //битый профиль
        await assert.rejects(() => WebWorker.prototype.getTileReadList.call(fake, '../x'), /invalid/);

        //профиль без файла -> пусто
        const res3 = await WebWorker.prototype.getTileReadList.call(fake, 'p2', 0, 50);
        assert.strictEqual(res3.total, 0);
        assert.deepStrictEqual(res3.books, []);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('getTileRatedList: по убыванию оценки, rating и review', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const fake = makeFakeThis({dataDir: dir});
        await writeUserData(dir, 'p1', {
            read: {},
            ratings: {'uid-a': 4, 'uid-b': 5, 'uid-x': 3},
            reviews: {'uid-b': 'отличный роман'},
        });

        const res = await WebWorker.prototype.getTileRatedList.call(fake, 'p1', 0, 50);
        assert.strictEqual(res.total, 3);
        assert.strictEqual(res.books.length, 2);
        assert.strictEqual(res.books[0]._uid, 'uid-b');
        assert.strictEqual(res.books[0].rating, 5);
        assert.strictEqual(res.books[0].review, 'отличный роман');
        assert.strictEqual(res.books[1]._uid, 'uid-a');
        assert.strictEqual(res.books[1].rating, 4);
        assert.strictEqual(res.books[1].review, '');

        //пагинация: третья запись uid-x удалена, страница пуста
        const res2 = await WebWorker.prototype.getTileRatedList.call(fake, 'p1', 2, 50);
        assert.strictEqual(res2.total, 3);
        assert.deepStrictEqual(res2.books, []);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('tileHiddenUids: uid прочитанных и оценённых по настройкам', () => {
    const fake = makeFakeThis();
    const ud = {
        hideRead: true,
        hideRated: true,
        read: {'uid-a': '2026-01-01'},
        ratings: {'uid-b': 5},
    };

    let s = WebWorker.prototype.tileHiddenUids.call(fake, ud);
    assert.ok(s.has('uid-a'));
    assert.ok(s.has('uid-b'));
    assert.strictEqual(s.size, 2);

    s = WebWorker.prototype.tileHiddenUids.call(fake, {hideRead: false, hideRated: true, read: {'uid-a': 't'}, ratings: {'uid-b': 5}});
    assert.deepStrictEqual([...s], ['uid-b']);

    s = WebWorker.prototype.tileHiddenUids.call(fake, {hideRead: true, hideRated: false, read: {'uid-a': 't'}, ratings: {}});
    assert.deepStrictEqual([...s], ['uid-a']);

    s = WebWorker.prototype.tileHiddenUids.call(fake, {hideRead: false, hideRated: false, read: {'uid-a': 't'}, ratings: {'uid-b': 5}});
    assert.strictEqual(s.size, 0);
});

test('toggleHideRead/toggleHideRated: webworker-обёртки', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const fake = makeFakeThis({dataDir: dir});

        assert.deepStrictEqual(await WebWorker.prototype.toggleHideRead.call(fake, 'p1'), {hideRead: true});
        assert.deepStrictEqual(await WebWorker.prototype.toggleHideRated.call(fake, 'p1'), {hideRated: true});
        assert.deepStrictEqual(await WebWorker.prototype.toggleHideRead.call(fake, 'p1'), {hideRead: false});

        const file = path.join(dir, 'userData', 'p1.json');
        const d = JSON.parse(await fs.readFile(file, 'utf8'));
        assert.strictEqual(d.hideRead, false);
        assert.strictEqual(d.hideRated, true);
    } finally { await cleanup(dir); resetSingletons(); }
});
