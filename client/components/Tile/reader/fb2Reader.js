//Парсер FB2 в браузере (DOMParser) — читалка работает офлайн, без запросов к серверу.
//
//Возвращает {title, author, sections, total, imageUrls}:
//  sections — все <section> в порядке документа (включая вложенные),
//    каждый {title, html} — html готов к v-html;
//  imageUrls — созданные object URL картинок (вызвать URL.revokeObjectURL при выходе).

const escapeHtml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

//<binary> → id -> {type, data(base64)}. Картинки конвертируются в blob URL
//только когда реально встречаются в тексте.
function makeImageResolver(doc, imageUrls) {
    const binaryMap = new Map();
    for (const b of doc.querySelectorAll('binary')) {
        const id = b.getAttribute('id');
        if (id)
            binaryMap.set(id, {
                type: b.getAttribute('content-type') || 'image/jpeg',
                data: b.textContent.trim(),
            });
    }

    const urlCache = new Map();
    return (imgEl) => {
        const href = imgEl.getAttribute('href') || '';
        const parts = href.split('/');
        const id = parts[parts.length - 1];
        const bin = binaryMap.get(id);
        if (!bin)
            return '';

        let url = urlCache.get(id);
        if (!url) {
            const raw = atob(bin.data);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++)
                bytes[i] = raw.charCodeAt(i);
            url = URL.createObjectURL(new Blob([bytes], {type: bin.type}));
            urlCache.set(id, url);
            imageUrls.push(url);
        }
        return `<img src="${url}"/>`;
    };
}

//внутреннее содержимое строчных элементов (p, emphasis, ...)
async function inlineHtml(node, resolver) {
    let html = '';
    for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
            html += escapeHtml(child.textContent);
        } else if (child.nodeType !== Node.ELEMENT_NODE) {
            continue;
        } else {
            const tag = child.localName;
            if (tag === 'line-break') {
                html += '<br>';
            } else if (tag === 'image') {
                html += await resolver(child);
            } else if (tag === 'a') {
                const href = child.getAttribute('href');
                if (href && !child.getAttribute('name'))
                    html += `<a href="${escapeHtml(href)}">${await inlineHtml(child, resolver)}</a>`;
                //анкоры <a name> не рендерим
            } else if (tag === 'p') {
                //вложенный <p> (редко) — отдельный абзац
                html += `<p class="fb2-nested">${await inlineHtml(child, resolver)}</p>`;
            } else if (tag === 'emphasis') {
                html += `<em>${await inlineHtml(child, resolver)}</em>`;
            } else if (tag === 'strong') {
                html += `<b>${await inlineHtml(child, resolver)}</b>`;
            } else if (tag === 'title') {
                html += `<b>${await inlineHtml(child, resolver)}</b>`;
            } else if (tag === 'subtitle') {
                html += `<em>${await inlineHtml(child, resolver)}</em>`;
            } else if (tag === 'date') {
                html += `<span class="fb2-date">${await inlineHtml(child, resolver)}</span>`;
            } else {
                html += await inlineHtml(child, resolver); //неизвестное — просто содержимое
            }
        }
    }
    return html;
}

//содержимое раздела, кроме <title> и вложенных <section> (они идут отдельными пунктами)
async function sectionHtml(section, resolver) {
    let html = '';
    for (const child of section.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE)
            continue;

        const tag = child.localName;
        if (tag === 'p') {
            html += `<p>${await inlineHtml(child, resolver)}</p>`;
        } else if (tag === 'title') {
            html += `<h3 class="fb2-title">${await inlineHtml(child, resolver)}</h3>`;
        } else if (tag === 'subtitle') {
            html += `<h4 class="fb2-subtitle">${await inlineHtml(child, resolver)}</h4>`;
        } else if (tag === 'epigraph') {
            html += `<div class="fb2-epigraph">${await inlineHtml(child, resolver)}</div>`;
        } else if (tag === 'annotation') {
            html += `<div class="fb2-annotation">${await inlineHtml(child, resolver)}</div>`;
        } else if (tag === 'poetry' || tag === 'verse-block' || tag === 'table' || tag === 'note') {
            html += `<div class="fb2-block">${await inlineHtml(child, resolver)}</div>`;
        }
        //section — пропускаем (уже в общем списке в порядке документа)
    }
    return html;
}

function personName(doc, tag) {
    const el = doc.querySelector(`description > ${tag}`);
    if (!el)
        return '';
    const last = el.querySelector('last-name');
    const first = el.querySelector('first-name');
    const middle = el.querySelector('middle-name');
    return [last && last.textContent, first && first.textContent, middle && middle.textContent]
        .map((s) => (s || '').trim())
        .filter((s) => s)
        .join(' ');
}

export async function parseFb2(buf) {
    const text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror'))
        throw new Error('Не удалось разобрать FB2 (ожидается UTF-8 XML)');

    const root = doc.querySelector('FictionBook') || doc.documentElement;

    const title = (doc.querySelector('description > title-info > title')?.textContent || '').trim();
    const author = personName(doc, 'author');

    const imageUrls = [];
    const resolver = makeImageResolver(doc, imageUrls);

    const sections = [];
    const sectionEls = root.querySelectorAll('body section');
    if (sectionEls.length) {
        for (const s of sectionEls) {
            const titleEl = s.querySelector(':scope > title');
            const secTitle = titleEl ? titleEl.textContent.trim() : '';
            const html = await sectionHtml(s, resolver);
            if (html || secTitle)
                sections.push({title: secTitle, html});
        }
    } else {
        const body = root.querySelector('body');
        if (body) {
            const html = await sectionHtml(body, resolver);
            if (html)
                sections.push({title: '', html});
        }
    }

    if (!sections.length)
        throw new Error('В FB2 не найдено текстовых разделов');

    return {title, author, sections, total: sections.length, imageUrls};
}
