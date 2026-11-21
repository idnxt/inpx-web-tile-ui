<template>
    <div class="reader-root">
        <div class="reader-topbar">
            <a class="reader-back" :href="`#/tile/book/${encodeURIComponent(uid)}`">
                <i class="la la-arrow-left" />
                <span>К книге</span>
            </a>
            <div class="col reader-title">
                <div class="reader-title-name">{{ displayName }}</div>
                <div v-if="displayAuthor" class="reader-title-author">{{ displayAuthor }}</div>
            </div>
            <div class="row items-center no-wrap">
                <DivBtn size="28" class="reader-font-btn" @meClick="changeFontSize(-1)">A−</DivBtn>
                <DivBtn size="28" class="reader-font-btn q-ml-xs" @meClick="changeFontSize(1)">A+</DivBtn>
                <DivBtn size="28" class="reader-font-btn q-ml-xs" icon="la la-trash" @meClick="removeFromDevice"
                    tooltip>
                    <template #tooltip>Удалить книгу с устройства</template>
                </DivBtn>
            </div>
        </div>

        <div class="reader-progress-line">
            <div class="reader-progress-fill" :style="{width: percent + '%'}" />
        </div>

        <div v-if="phase === 'loading'" class="reader-status">
            <div class="reader-status-msg">{{ statusMessage }}</div>
            <div v-if="downloadTotal" class="reader-progress-bar">
                <div class="reader-progress-fill" :style="{width: downloadPercent + '%'}" />
            </div>
            <div v-if="downloadTotal" class="reader-status-sub">{{ downloadSizeText }}</div>
        </div>

        <div v-else-if="phase === 'error'" class="reader-status">
            <div class="text-red">{{ error }}</div>
            <div class="row q-mt-md">
                <DivBtn size="32" @meClick="retry">Повторить</DivBtn>
                <a class="q-ml-md reader-link" :href="`#/tile/book/${encodeURIComponent(uid)}`">К странице книги</a>
            </div>
        </div>

        <template v-else-if="phase === 'ready' && currentSection">
            <div ref="content" class="reader-content" :style="{fontSize: fontSize + 'px'}" @scroll="onScroll">
                <div class="reader-content-inner">
                    <h2 v-if="currentSection.title" class="reader-section-title">{{ currentSection.title }}</h2>
                    <div class="reader-section-html" v-html="currentSection.html" />
                </div>
            </div>
            <div class="reader-bottombar">
                <div class="row items-center no-wrap">
                    <DivBtn size="32" icon="la la-chevron-left" :disabled="sectionIndex === 0" @meClick="prevSection">Назад</DivBtn>
                    <span class="col reader-pos">{{ sectionIndex + 1 }} / {{ book.total }} · {{ percent }}%</span>
                    <DivBtn size="32" icon="la la-chevron-right" :disabled="sectionIndex >= book.total - 1" @meClick="nextSection">Дальше</DivBtn>
                </div>
            </div>
        </template>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import DivBtn from '../share/DivBtn.vue';
import {parseFb2} from './reader/fb2Reader';
import {parseEpub} from './reader/epubReader';
import * as readerStorage from './reader/readerStorage';

const componentOptions = {
    components: {
        DivBtn,
    },
    watch: {
        $route() {
            //та же маршрутная схема, другой uid — перечитываем
            if (this.$route.params.uid && this.$route.params.uid !== this.uid)
                this.reload();
        },
    },
};
class TileReader {
    _options = componentOptions;

    uid = '';
    phase = 'loading'; //loading | ready | error
    statusMessage = '';
    error = '';
    book = null; // {title, author, sections, total, imageUrls}
    sectionIndex = 0;
    fontSize = 18;
    offsetFrac = 0;
    downloadLoaded = 0;
    downloadTotal = 0;
    meta = null;

    scrollSaveTimer = null;
    lastOffsetUpdate = 0;
    loadToken = 0;

    get profile() {
        return (this.$store.state.settings.tileProfile || '');
    }

    get currentSection() {
        return (this.book && this.book.sections[this.sectionIndex]) || null;
    }

    get percent() {
        if (!this.book || !this.book.total)
            return 0;
        return Math.min(100, Math.round(((this.sectionIndex + this.offsetFrac) / this.book.total) * 100));
    }

    get downloadPercent() {
        if (!this.downloadTotal)
            return 0;
        return Math.min(100, (this.downloadLoaded / this.downloadTotal) * 100);
    }

    get downloadSizeText() {
        if (!this.downloadTotal)
            return '';
        const mb = (n) => (n / (1024 * 1024)).toFixed(1);
        return `${mb(this.downloadLoaded)} / ${mb(this.downloadTotal)} МБ`;
    }

    get displayName() {
        if (this.book && this.book.title)
            return this.book.title;
        if (this.meta && this.meta.title)
            return this.meta.title;
        return 'Книга';
    }

    get displayAuthor() {
        if (this.book && this.book.author)
            return this.book.author;
        return (this.meta && this.meta.author) || '';
    }

    created() {
        this.api = this.$root.api;
        this.uid = this.$route.params.uid || '';
    }

    mounted() {
        this.fontSize = parseInt(localStorage.getItem('inpx-reader-fontSize'), 10) || 18;
        window.addEventListener('pagehide', this.onPageHide);
        document.addEventListener('visibilitychange', this.onVisChange);
        window.addEventListener('keydown', this.onKeydown);
        this.load();
    }

    beforeRouteLeave() {
        this.flushProgress();
    }

    beforeUnmount() {
        window.removeEventListener('pagehide', this.onPageHide);
        document.removeEventListener('visibilitychange', this.onVisChange);
        window.removeEventListener('keydown', this.onKeydown);
        this.clearScrollTimer();
        this.flushProgress();
        this.revokeImageUrls();
    }

    reload() {
        this.revokeImageUrls();
        this.uid = this.$route.params.uid || '';
        this.load();
    }

    async load() {
        if (!this.uid) {
            this.phase = 'error';
            this.error = 'Не задана книга';
            return;
        }

        const token = ++this.loadToken;
        this.phase = 'loading';
        this.statusMessage = 'Открываю книгу...';
        this.error = '';
        this.book = null;
        this.sectionIndex = 0;
        this.offsetFrac = 0;
        this.downloadLoaded = 0;
        this.downloadTotal = 0;

        try {
            let data = await readerStorage.getBook(this.uid);
            if (!data) {
                await this.downloadBook(token);
                data = await readerStorage.getBook(this.uid);
                if (!data)
                    throw new Error('Не удалось сохранить книгу на устройство');
            }
            this.meta = data.meta;

            if (token !== this.loadToken)
                return;

            this.statusMessage = 'Формирую текст...';
            const buf = new Uint8Array(data.buf);
            const ext = (this.meta && this.meta.ext) || this.detectExt(buf);
            let parsed;
            if (ext === 'fb2')
                parsed = await parseFb2(buf);
            else if (ext === 'epub')
                parsed = await parseEpub(buf);
            else
                throw new Error(`Формат '${ext || 'неизвестный'}' не поддерживается читалкой (FB2/EPUB)`);

            if (token !== this.loadToken)
                return;

            this.book = parsed;

            //вернёмся к сохранённому месту
            const prog = await readerStorage.getProgress(this.uid);
            if (prog && prog.total === this.book.total && token === this.loadToken) {
                this.sectionIndex = Math.max(0, Math.min(this.book.total - 1, (prog.section || 1) - 1));
                this.offsetFrac = Math.max(0, Math.min(1, prog.frac || 0));
            }

            this.phase = 'ready';
            this.$nextTick(() => this.restoreScroll());
        } catch (e) {
            if (token !== this.loadToken)
                return;
            this.phase = 'error';
            this.error = e.message;
        }
    }

    //загружаем файл книги целиком на устройство и кэшируем локально —
    //далее чтение идёт без обращения к серверу
    async downloadBook(token) {
        this.statusMessage = 'Загружаю книгу с сервера...';

        const res = await this.api.getBookLink(this.uid);
        if (!res.link)
            throw new Error('Сервер не дал ссылку на книгу');

        const resp = await fetch(res.link, {cache: 'no-store'});
        if (!resp.ok)
            throw new Error(`Ошибка сервера: ${resp.status}`);

        this.downloadTotal = parseInt(resp.headers.get('content-length'), 10) || 0;

        const reader = resp.body.getReader();
        const chunks = [];
        let total = 0;
        for (; ;) {
            const {done, value} = await reader.read();
            if (done)
                break;
            chunks.push(value);
            total += value.length;
            this.downloadLoaded = total;
        }
        if (token !== this.loadToken)
            return;

        const buf = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
            buf.set(c, o);
            o += c.length;
        }

        //сохраняем название/автора, которые уже положил сюда TileBook
        const prev = (await readerStorage.getMeta(this.uid)) || {};
        await readerStorage.saveBook(this.uid, buf.buffer, {
            ...prev,
            uid: this.uid,
            ext: this.detectExt(buf),
            size: total,
            savedAt: Date.now(),
        });
    }

    detectExt(bytes) {
        if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
            return 'epub';
        const head = new TextDecoder('utf-8').decode(bytes.slice(0, 512));
        if (head.includes('FictionBook'))
            return 'fb2';
        return '';
    }

    restoreScroll() {
        const el = this.$refs.content;
        if (el && this.offsetFrac > 0)
            el.scrollTop = this.offsetFrac * (el.scrollHeight - el.clientHeight);
    }

    currentScrollFrac() {
        const el = this.$refs.content;
        if (!el)
            return this.offsetFrac;
        const max = el.scrollHeight - el.clientHeight;
        return (max > 0 ? el.scrollTop / max : 0);
    }

    makeProgress() {
        if (!this.book)
            return null;
        return {
            section: this.sectionIndex + 1,
            total: this.book.total,
            frac: this.currentScrollFrac(),
            time: (new Date()).toISOString(),
        };
    }

    //прогресс: всегда локально (офлайн), на сервер — если задан профиль
    saveProgressLocal() {
        const p = this.makeProgress();
        if (p)
            readerStorage.saveProgress(this.uid, p); //no await
    }

    syncProgressToServer() {
        if (!this.profile)
            return;
        const p = this.makeProgress();
        if (!p)
            return;
        this.api.setUserProgress(this.profile, this.uid, p).catch(() => {}); //best effort
    }

    flushProgress() {
        this.clearScrollTimer();
        this.saveProgressLocal();
        this.syncProgressToServer();
    }

    clearScrollTimer() {
        if (this.scrollSaveTimer) {
            clearTimeout(this.scrollSaveTimer);
            this.scrollSaveTimer = null;
        }
    }

    onScroll() {
        //обновляем процент не чаще раза в 200 мс
        const now = Date.now();
        if (now - this.lastOffsetUpdate > 200) {
            this.lastOffsetUpdate = now;
            this.offsetFrac = this.currentScrollFrac();
        }

        if (!this.scrollSaveTimer)
            this.scrollSaveTimer = setTimeout(() => {
                this.scrollSaveTimer = null;
                this.saveProgressLocal();
            }, 2000);
    }

    prevSection() {
        this.goSection(this.sectionIndex - 1);
    }

    nextSection() {
        this.goSection(this.sectionIndex + 1);
    }

    goSection(i) {
        if (!this.book || i < 0 || i >= this.book.total)
            return;

        this.saveProgressLocal();
        this.sectionIndex = i;
        this.offsetFrac = 0;
        this.lastOffsetUpdate = 0;
        const el = this.$refs.content;
        if (el)
            el.scrollTop = 0;
        this.$nextTick(() => this.saveProgressLocal());
    }

    onKeydown(e) {
        if (this.phase !== 'ready')
            return;
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            this.nextSection();
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            this.prevSection();
        }
    }

    onPageHide() {
        this.flushProgress();
    }

    onVisChange() {
        if (document.visibilityState === 'hidden')
            this.flushProgress();
    }

    changeFontSize(delta) {
        this.fontSize = Math.max(12, Math.min(32, this.fontSize + delta * 2));
        localStorage.setItem('inpx-reader-fontSize', String(this.fontSize));
    }

    async removeFromDevice() {
        const ok = await this.$root.stdDialog.confirm(
            'Удалить книгу и прогресс с этого устройства?',
            'Удаление с устройства',
        );
        if (!ok)
            return;

        await readerStorage.removeBook(this.uid);
        await readerStorage.removeProgress(this.uid);

        this.book = null;
        this.meta = null;
        this.sectionIndex = 0;
        this.offsetFrac = 0;
        this.phase = 'loading';
        this.statusMessage = 'Открываю книгу...';
        this.load();
    }

    retry() {
        this.load();
    }

    revokeImageUrls() {
        if (this.book && this.book.imageUrls) {
            for (const u of this.book.imageUrls)
                URL.revokeObjectURL(u);
        }
    }
}

export default vueComponent(TileReader);
</script>

<style scoped>
.reader-root {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: #fff;
    display: flex;
    flex-direction: column;
    font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

.reader-topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid #e0e0e0;
    background: #fafafa;
    min-height: 48px;
}

.reader-back {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    color: #333;
    white-space: nowrap;
    text-decoration: none;
    font-size: 13px;
}

.reader-back:hover {
    color: #000;
}

.reader-title {
    overflow: hidden;
}

.reader-title-name {
    font-weight: 600;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.reader-title-author {
    font-size: 12px;
    color: #666;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.reader-font-btn {
    font-size: 12px;
}

.reader-progress-line {
    height: 3px;
    background: #eee;
}

.reader-progress-fill {
    height: 100%;
    background: #4caf50;
    transition: width 0.2s linear;
}

.reader-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px 16px 32px 16px;
    line-height: 1.65;
}

.reader-content-inner {
    max-width: 720px;
    margin: 0 auto;
}

.reader-section-title {
    font-size: 1.4em;
    font-weight: 600;
    margin: 8px 0 16px 0;
    color: #222;
}

.reader-section-html p {
    margin: 0 0 0.9em 0;
    text-align: justify;
}

.reader-section-html .fb2-nested {
    margin: 0.5em 0;
}

.reader-section-html .fb2-title,
.reader-section-html .fb2-subtitle {
    text-align: center;
    margin: 1.5em 0;
}

.reader-section-html .fb2-epigraph,
.reader-section-html .fb2-annotation,
.reader-section-html .fb2-block {
    margin: 1em 0;
    padding: 0 12px;
    color: #444;
}

.reader-section-html img {
    max-width: 100%;
    display: block;
    margin: 1em auto;
}

.reader-section-html blockquote {
    margin: 1em 0;
    padding-left: 16px;
    border-left: 3px solid #ddd;
    color: #444;
}

.reader-section-html pre {
    background: #f6f6f6;
    padding: 8px;
    overflow-x: auto;
}

.reader-status {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    gap: 12px;
    color: #555;
}

.reader-status-msg {
    font-size: 15px;
}

.reader-status-sub {
    font-size: 13px;
    color: #888;
}

.reader-progress-bar {
    width: 80%;
    max-width: 320px;
    height: 8px;
    border-radius: 4px;
    background: #eee;
    overflow: hidden;
}

.reader-link {
    color: #1976d2;
    text-decoration: none;
    font-size: 14px;
}

.reader-link:hover {
    text-decoration: underline;
}

.reader-bottombar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom)) 12px;
    border-top: 1px solid #e0e0e0;
    background: #fafafa;
}

.reader-pos {
    font-size: 13px;
    color: #555;
    text-align: center;
    white-space: nowrap;
}
</style>
