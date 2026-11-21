const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('path');
const UserData = require('../../server/core/UserData');
const { makeTmpDir, cleanup } = require('../helpers/tmpdir');
const { resetSingletons } = require('../helpers/instances');

function makeConfig(dataDir) {
    return { dataDir };
}

test('validProfile: допустимые и запрещённые имена', () => {
    assert.ok(UserData.validProfile('a'));
    assert.ok(UserData.validProfile('Reader_2026'));
    assert.ok(UserData.validProfile('a.b-c_d'));
    assert.ok(UserData.validProfile('x'.repeat(32)));

    assert.ok(!UserData.validProfile(''));
    assert.ok(!UserData.validProfile(null));
    assert.ok(!UserData.validProfile(123));
    assert.ok(!UserData.validProfile('..'));
    assert.ok(!UserData.validProfile('../x'));
    assert.ok(!UserData.validProfile('a b'));
    assert.ok(!UserData.validProfile('имя'));
    assert.ok(!UserData.validProfile('x'.repeat(33)));
});

test('оценка: поставить/перепоставить/снять, ограничение диапазоном 0..5', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const user = new UserData(makeConfig(dir));

        assert.deepStrictEqual(await user.setRating('p1', 'uid-a', 4), {rating: 4});
        assert.deepStrictEqual(await user.setRating('p1', 'uid-a', 2), {rating: 2});

        //больше 5 — ограничить до 5
        assert.deepStrictEqual(await user.setRating('p1', 'uid-b', 9), {rating: 5});

        //0 — снять
        assert.deepStrictEqual(await user.setRating('p1', 'uid-a', 0), {rating: 0});
        const d = await user.getData('p1');
        assert.ok(!('uid-a' in d.ratings));
        assert.strictEqual(d.ratings['uid-b'], 5);

        assert.throws(() => user.setRating('p1', 'uid-a', 'x'), /invalid rating/);
        assert.throws(() => user.setRating('p1', '', 3), /invalid rating/);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('отзыв: поставить/перезаписать/удалить/слишком длинный', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const user = new UserData(makeConfig(dir));

        assert.deepStrictEqual(await user.setReview('p1', 'uid-a', '  Хорошо  '), {review: 'Хорошо'});
        assert.deepStrictEqual(await user.setReview('p1', 'uid-a', 'Отлично'), {review: 'Отлично'});

        //пустой текст — удалить
        assert.deepStrictEqual(await user.setReview('p1', 'uid-a', ''), {review: ''});
        const d = await user.getData('p1');
        assert.ok(!('uid-a' in d.reviews));

        assert.throws(() => user.setReview('p1', 'uid-a', 'x'.repeat(4001)), /review too long/);
        assert.throws(() => user.setReview('p1', '', 'тест'), /invalid book uid/);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('прочитано: отметить и снять', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const user = new UserData(makeConfig(dir));

        assert.deepStrictEqual(await user.toggleRead('p1', 'uid-a'), {read: true});
        const d1 = await user.getData('p1');
        assert.ok(d1.read['uid-a']);

        assert.deepStrictEqual(await user.toggleRead('p1', 'uid-a'), {read: false});
        const d2 = await user.getData('p1');
        assert.ok(!('uid-a' in d2.read));

        assert.throws(() => user.toggleRead('p1', ''), /invalid book uid/);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('прогресс чтения: сохранить/перезаписать, ограничение значений', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const user = new UserData(makeConfig(dir));

        const res = await user.setProgress('p1', 'uid-a', {section: 10, total: 100, frac: 0.5});
        assert.strictEqual(res.progress.section, 10);
        assert.strictEqual(res.progress.total, 100);
        assert.strictEqual(res.progress.frac, 0.5);
        assert.ok(res.progress.time);

        let d = await user.getData('p1');
        assert.deepStrictEqual(d.progress['uid-a'], res.progress);

        //перезаписать
        await user.setProgress('p1', 'uid-a', {section: 20, total: 100, frac: 0.25});
        d = await user.getData('p1');
        assert.strictEqual(d.progress['uid-a'].section, 20);

        //ограничение: section < 1, frac вне 0..1; повреждённый total
        await user.setProgress('p1', 'uid-b', {section: -5, total: 50, frac: 9});
        d = await user.getData('p1');
        assert.deepStrictEqual(d.progress['uid-b'], {section: 1, total: 50, frac: 1, time: d.progress['uid-b'].time});

        //повреждённые значения — значения по умолчанию
        await user.setProgress('p1', 'uid-c', {section: 'x', total: 'y'});
        d = await user.getData('p1');
        assert.strictEqual(d.progress['uid-c'].section, 1);
        assert.strictEqual(d.progress['uid-c'].total, 1);

        //несуществующий uid — ошибка
        assert.throws(() => user.setProgress('p1', '', {section: 1, total: 2}), /invalid book uid/);

        //прогресс не пересекается с прочими данными
        await user.toggleRead('p1', 'uid-a');
        d = await user.getData('p1');
        assert.ok(d.read['uid-a']);
        assert.strictEqual(d.progress['uid-a'].section, 20);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('игнор книги/автора/серии: добавить/дубликат/удалить', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const user = new UserData(makeConfig(dir));

        assert.deepStrictEqual(
            await user.ignoreItem('p1', 'book', 'uid-a', {title: 'Т', author: 'А', series: 'С'}),
            {ignored: true},
        );
        //дубликат
        assert.deepStrictEqual(
            await user.ignoreItem('p1', 'book', 'uid-a', {}),
            {ignored: false},
        );

        assert.deepStrictEqual(await user.ignoreItem('p1', 'author', '42', {name: 'Иванов'}), {ignored: true});
        assert.deepStrictEqual(await user.ignoreItem('p1', 'author', '42', {name: 'Иванов'}), {ignored: false});

        assert.deepStrictEqual(await user.ignoreItem('p1', 'series', 'Моя серия', {count: 5}), {ignored: true});
        //серии — без учёта регистра
        assert.deepStrictEqual(await user.ignoreItem('p1', 'series', 'МОЯ СЕРИЯ', {}), {ignored: false});

        let d = await user.getData('p1');
        assert.strictEqual(d.ignored.books.length, 1);
        assert.strictEqual(d.ignored.authors.length, 1);
        assert.strictEqual(d.ignored.series.length, 1);

        //удалить
        assert.deepStrictEqual(await user.removeIgnore('p1', 'book', 'uid-a'), {removed: true});
        assert.deepStrictEqual(await user.removeIgnore('p1', 'author', '42'), {removed: true});
        assert.deepStrictEqual(await user.removeIgnore('p1', 'series', 'моя серия'), {removed: true});
        //повторно — не найдено
        assert.deepStrictEqual(await user.removeIgnore('p1', 'book', 'uid-a'), {removed: false});

        d = await user.getData('p1');
        assert.deepStrictEqual(d.ignored, {books: [], authors: [], series: []});

        await assert.rejects(() => user.ignoreItem('p1', 'unknown', 'x'), /invalid ignore kind/);
        await assert.rejects(() => user.ignoreItem('p1', 'book', ''), /invalid ignore value/);
        assert.throws(() => user.removeIgnore('p1', 'book', ''), /invalid ignore key/);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('ленты: отключить и включить', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const user = new UserData(makeConfig(dir));

        assert.deepStrictEqual(await user.toggleFeed('p1', 'new'), {disabled: true});
        assert.deepStrictEqual(await user.toggleFeed('p1', 'genre-new:f1,f2'), {disabled: true});
        assert.deepStrictEqual(await user.toggleFeed('p1', 'new'), {disabled: false});

        const d = await user.getData('p1');
        assert.deepStrictEqual(d.disabledFeeds, ['genre-new:f1,f2']);

        assert.throws(() => user.toggleFeed('p1', ''), /invalid feed id/);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('профили: список, изоляция, перезагрузка с диска', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const user = new UserData(makeConfig(dir));
        await user.setRating('alpha', 'uid-a', 3);
        await user.toggleRead('beta', 'uid-b');

        assert.deepStrictEqual((await user.listProfiles()).sort(), ['alpha', 'beta']);

        //профили не пересекаются
        const a = await user.getData('alpha');
        assert.strictEqual(a.ratings['uid-a'], 3);
        assert.ok(!('uid-b' in a.read));
        const b = await user.getData('beta');
        assert.ok(!('uid-a' in b.ratings));
        assert.ok(b.read['uid-b']);

        //новая инстанция читает с диска
        resetSingletons();
        const user2 = new UserData(makeConfig(dir));
        const a2 = await user2.getData('alpha');
        assert.strictEqual(a2.ratings['uid-a'], 3);

        //несуществующий профиль — пустые данные
        const empty = await user2.getData('gamma');
        assert.deepStrictEqual(empty, user2.emptyData());

        //пустой профиль не создаёт файл
        assert.deepStrictEqual((await user2.listProfiles()).sort(), ['alpha', 'beta']);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('недопустимое имя профиля: getData -> null, запись — ошибка', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const user = new UserData(makeConfig(dir));

        assert.strictEqual(await user.getData('../evil'), null);
        await assert.rejects(() => user.setRating('../evil', 'uid', 3), /invalid profile name/);
        await assert.rejects(() => user.ignoreItem('a b', 'book', 'uid'), /invalid profile name/);

        //файлы не должны появляться
        assert.deepStrictEqual(await user.listProfiles(), []);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('скрытие прочитанных/оценённых: переключатели и нормализация', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        const user = new UserData(makeConfig(dir));

        //по умолчанию скрытие выключено
        const d0 = await user.getData('p1');
        assert.strictEqual(d0.hideRead, false);
        assert.strictEqual(d0.hideRated, false);

        assert.deepStrictEqual(await user.toggleHideRead('p1'), {hideRead: true});
        assert.deepStrictEqual(await user.toggleHideRated('p1'), {hideRated: true});
        assert.deepStrictEqual(await user.toggleHideRead('p1'), {hideRead: false});

        const d = await user.getData('p1');
        assert.strictEqual(d.hideRead, false);
        assert.strictEqual(d.hideRated, true);

        //значения переживают перезагрузку с диска
        resetSingletons();
        const user2 = new UserData(makeConfig(dir));
        const d2 = await user2.getData('p1');
        assert.strictEqual(d2.hideRated, true);
        assert.strictEqual(d2.hideRead, false);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('скрытие: повреждённый файл не ломает normalize', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        await fs.ensureDir(path.join(dir, 'userData'));
        await fs.writeFile(path.join(dir, 'userData', 'p.json'), JSON.stringify({hideRead: 'yes', hideRated: null}));

        const user = new UserData(makeConfig(dir));
        const d = await user.getData('p');
        assert.strictEqual(d.hideRead, true);
        assert.strictEqual(d.hideRated, false);
    } finally { await cleanup(dir); resetSingletons(); }
});

test('повреждённый файл профиля -> пустые данные, не падает', async () => {
    const dir = await makeTmpDir();
    try {
        resetSingletons();
        await fs.ensureDir(path.join(dir, 'userData'));
        await fs.writeFile(path.join(dir, 'userData', 'bad.json'), '{not json');

        const user = new UserData(makeConfig(dir));
        const d = await user.getData('bad');
        assert.deepStrictEqual(d, user.emptyData());

        //запись поверх повреждённого файла восстанавливает профиль
        await user.setRating('bad', 'uid-a', 5);
        const d2 = await user.getData('bad');
        assert.strictEqual(d2.ratings['uid-a'], 5);
    } finally { await cleanup(dir); resetSingletons(); }
});
