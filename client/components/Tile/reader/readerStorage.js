import localForage from 'localforage';

//Локальное хранилище читалки: байты книги (кэшируются после загрузки с сервера)
//и прогресс чтения. IndexedDB (localforage) — чтение полностью офлайн,
//размер ограничен только квотой браузера.
//
//Прогресс: {section, total, frac, time}
//  section — номер раздела (с 1), total — всего разделов,
//  frac — доля прокрутки внутри раздела (0..1).

const bookStore = localForage.createInstance({
    name: 'inpx-reader-book',
});
const progressStore = localForage.createInstance({
    name: 'inpx-reader-progress',
});

const bookKey = (uid) => `book-${uid}`;
const metaKey = (uid) => `meta-${uid}`;
const progressKey = (uid) => `prog-${uid}`;

export async function saveBook(uid, buf, meta) {
    await bookStore.setItem(bookKey(uid), buf); //ArrayBuffer
    if (meta)
        await bookStore.setItem(metaKey(uid), meta);
}

export async function saveMeta(uid, meta) {
    await bookStore.setItem(metaKey(uid), meta);
}

export async function getMeta(uid) {
    return (await bookStore.getItem(metaKey(uid))) || null;
}

export async function getBook(uid) {
    const buf = await bookStore.getItem(bookKey(uid));
    if (!buf)
        return null;

    const meta = (await bookStore.getItem(metaKey(uid))) || null;
    return {buf, meta};
}

export async function removeBook(uid) {
    await bookStore.removeItem(bookKey(uid));
    await bookStore.removeItem(metaKey(uid));
}

export async function saveProgress(uid, progress) {
    if (!progress)
        return;

    await progressStore.setItem(progressKey(uid), progress);
}

export async function getProgress(uid) {
    return (await progressStore.getItem(progressKey(uid))) || null;
}

export async function removeProgress(uid) {
    await progressStore.removeItem(progressKey(uid));
}
