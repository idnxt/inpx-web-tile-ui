//Парсер EPUB в браузере (jszip) — читалка работает офлайн, без запросов к серверу.
//Возвращает то же, что parseFb2: {title, author, sections, total, imageUrls}.
//Поддерживает распространённый подмножество EPUB 2/3 (spine из html-документов).

import JSZip from 'jszip';

const escapeHtml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
};

function mimeForPath(p) {
    const i = p.lastIndexOf('.');
    return (i >= 0 ? (MIME_BY_EXT[p.slice(i).toLowerCase()] || 'application/octet-stream') : 'application/octet-stream');
}

//внутреннее содержимое строки (текст + img/a/em/strong/b/i/u/sup/sub/br/...)
async function inlineHtml(node, getImgUrl) {
    let html = '';
    for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            html += escapeHtml(child.textContent);
        } else if (child.nodeType !== Node.ELEMENT_NODE) {
            continue;
        } else {
            const tag = child.localName.toLowerCase();
            if (tag === 'br') {
                html += '<br>';
            } else if (tag === 'img') {
                const src = await getImgUrl(child.getAttribute('src') || '');
                if (src)
                    html += `<img src="${src}"/>`;
            } else if (['em', 'strong', 'b', 'i', 'u', 's', 'sup', 'sub', 'small', 'code', 'mark'].includes(tag)) {
                html += `<${tag}>${await inlineHtml(child, getImgUrl)}</${tag}>`;
            } else if (tag === 'a') {
                const href = child.getAttribute('href');
                html += href
                    ? `<a href="${escapeHtml(href)}">${await inlineHtml(child, getImgUrl)}</a>`
                    : await inlineHtml(child, getImgUrl);
            } else if (tag === 'p') {
                html += `<p class="fb2-nested">${await inlineHtml(child, getImgUrl)}</p>`;
            } else {
                html += await inlineHtml(child, getImgUrl); //span, ruby-внутренности и пр.
            }
        }
    }
    return html;
}

//блоки тела документа: p, h1..h6, blockquote, pre, ul/ol, figure, hr; div/section — разворачиваются
async function blockHtml(node, getImgUrl) {
    let html = '';
    for (const child of node.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE)
            continue;

        const tag = child.localName.toLowerCase();
        if (tag === 'p') {
            html += `<p>${await inlineHtml(child, getImgUrl)}</p>`;
        } else if (/^h[1-6]$/.test(tag)) {
            html += `<h3 class="fb2-title">${await inlineHtml(child, getImgUrl)}</h3>`;
        } else if (tag === 'blockquote') {
            html += `<blockquote>${await blockHtml(child, getImgUrl)}</blockquote>`;
        } else if (tag === 'pre') {
            html += `<pre>${escapeHtml(child.textContent)}</pre>`;
        } else if (tag === 'ul' || tag === 'ol') {
            let items = '';
            for (const li of child.querySelectorAll(':scope > li'))
                items += `<li>${await blockHtml(li, getImgUrl)}</li>`;
            html += `<${tag}>${items}</${tag}>`;
        } else if (tag === 'figure') {
            html += `<figure class="fb2-block">${await blockHtml(child, getImgUrl)}</figure>`;
        } else if (tag === 'hr') {
            html += '<hr>';
        } else if (tag === 'div' || tag === 'section' || tag === 'main' || tag === 'article') {
            html += await blockHtml(child, getImgUrl); //разворачиваем
        }
        //header, aside, nav, script, style — пропускаем
    }
    return html;
}

//заголовок раздела: первый заголовок документа. Элемент вырезаем —
//иначе он продублируется и в title, и в теле раздела
function docTitle(doc) {
    const h = doc.querySelector('h1, h2, h3, [role="heading"], header p, header h1, header h2');
    if (!h)
        return '';
    const t = h.textContent.replace(/\s+/g, ' ').trim();
    h.remove();
    return t;
}

export async function parseEpub(buf) {
    const zip = await JSZip.loadAsync(buf);

    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile)
        throw new Error('Неверный EPUB: нет META-INF/container.xml');
    const cdoc = new DOMParser().parseFromString(await containerFile.async('string'), 'application/xml');
    if (cdoc.querySelector('parsererror'))
        throw new Error('Неверный EPUB: битый container.xml');
    const rootfilePath = cdoc.querySelector('rootfile')?.getAttribute('full-path');
    if (!rootfilePath)
        throw new Error('Неверный EPUB: нет rootfile');

    const packageFile = zip.file(rootfilePath);
    if (!packageFile)
        throw new Error('Неверный EPUB: нет package-файла');
    const pdoc = new DOMParser().parseFromString(await packageFile.async('string'), 'application/xml');
    if (pdoc.querySelector('parsererror'))
        throw new Error('Неверный EPUB: битый package.xml');

    const baseDir = rootfilePath.substring(0, rootfilePath.lastIndexOf('/') + 1);
    const resolvePath = (href) => {
        if (/^https?:/.test(href))
            return href;
        const noFragment = href.split('#')[0];
        return baseDir + noFragment;
    };

    //manifest: id -> {href, mediaType}
    const manifest = new Map();
    for (const m of pdoc.querySelectorAll('manifest > item')) {
        const id = m.getAttribute('id');
        if (id)
            manifest.set(id, {href: m.getAttribute('href'), mediaType: m.getAttribute('media-type') || ''});
    }

    //картинки: zip-путь -> object URL (лениво, только используемые)
    const imageUrls = [];
    const imgCache = new Map();
    const getImgUrl = async (src) => {
        if (!src)
            return '';
        if (/^https?:/.test(src))
            return src;
        const p = resolvePath(src);
        if (!zip.file(p))
            return '';

        let url = imgCache.get(p);
        if (!url) {
            const data = await zip.file(p).async('uint8array');
            const item = [...manifest.values()].find((m) => m.href === p);
            const type = (item && /image\//.test(item.mediaType)) ? item.mediaType : mimeForPath(p);
            url = URL.createObjectURL(new Blob([data], {type}));
            imgCache.set(p, url);
            imageUrls.push(url);
        }
        return url;
    };

    const spine = pdoc.querySelector('spine');
    const sections = [];
    if (spine) {
        for (const itemref of spine.querySelectorAll('itemref')) {
            const item = manifest.get(itemref.getAttribute('idref'));
            if (!item)
                continue;
            if (!/x-?html/.test(item.mediaType) && !/\.x?html$/i.test(item.href))
                continue;

            const f = zip.file(resolvePath(item.href));
            if (!f)
                continue;

            const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xhtml+xml');
            if (doc.querySelector('parsererror'))
                continue;
            const body = doc.querySelector('body');
            if (!body)
                continue;

            const secTitle = docTitle(doc); //вырезаем ДО построения html, чтобы не дублировать
            const html = await blockHtml(body, getImgUrl);
            if (html)
                sections.push({title: secTitle, html});
        }
    }

    if (!sections.length)
        throw new Error('В EPUB не найдено текстовых разделов');

    const metaText = (name) => {
        const el = pdoc.querySelector(`meta[name="${name}"]`);
        if (el)
            return (el.getAttribute('content') || '').trim();
        return '';
    };
    const title = (pdoc.querySelector('dc\\:title')?.textContent || metaText('dc:title') || '').trim();
    const author = (pdoc.querySelector('dc\\:creator')?.textContent || metaText('dc:creator') || '').trim();

    return {title, author, sections, total: sections.length, imageUrls};
}
