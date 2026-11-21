<template>
    <div class="reader-root" :class="'theme-' + theme"
        @pointermove="onUiActivity" @mouseleave="hideUiNow">
        <div class="reader-hud-top" :class="{off: !uiVisible}">
            <div class="reader-topbar">
                <a class="reader-back" :href="`#/tile/book/${encodeURIComponent(uid)}`">
                    <i class="la la-arrow-left" />
                    <span>К книге</span>
                </a>
                <div class="col reader-title">
                    <div class="reader-title-name">{{ displayName }}</div>
                    <div v-if="displayAuthor" class="reader-title-author">{{ displayAuthor }}</div>
                    <div v-if="phase === 'ready' && book" class="reader-title-pos">
                        {{ sectionIndex + 1 }} / {{ book.total }} · {{ percent }}%
                    </div>
                </div>
                <div class="row items-center no-wrap">
                    <DivBtn size="28" class="reader-font-btn" @meClick="changeFontSize(-1)">A−</DivBtn>
                    <DivBtn size="28" class="reader-font-btn q-ml-xs" @meClick="changeFontSize(1)">A+</DivBtn>
                    <DivBtn size="28" class="reader-font-btn q-ml-xs" icon="la la-cog" @meClick="openPanel" tooltip>
                        <template #tooltip>Настройки читалки</template>
                    </DivBtn>
                </div>
            </div>
            <div class="reader-progress-line">
                <div class="reader-progress-fill" :style="{width: percent + '%'}" />
            </div>
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

        <!--все разделы одной лентой; режим листания — шаги по страницам (экранам)-->
        <div v-else-if="phase === 'ready' && book"
            ref="content"
            class="reader-content" :class="contentFontClass" :style="{fontSize: fontSize + 'px'}"
            @click="onPageTap"
            @touchstart.passive="onTouchStart" @touchend="onTouchEnd">
            <div class="reader-content-inner">
                <div v-for="(sec, i) in book.sections" :key="i" class="reader-section">
                    <h2 v-if="sec.title" class="reader-section-title">{{ sec.title }}</h2>
                    <div class="reader-section-html" v-html="sec.html" />
                </div>
            </div>
        </div>

        <!--панель настроек-->
        <div v-if="panelOpen" class="reader-panel-backdrop" @click="closePanel" />
        <div class="reader-panel" :class="{open: panelOpen}">
            <div class="row items-center reader-panel-head">
                <span class="col reader-panel-title">Настройки читалки</span>
                <span class="rp-close" @click="closePanel"><i class="la la-times" /></span>
            </div>
            <div class="column reader-panel-body">
                <div class="row items-center reader-panel-row">
                    <span class="reader-panel-label">Тема</span>
                    <div class="rp-opt" :class="{active: theme === 'day'}" @click="setTheme('day')">Дневная</div>
                    <div class="rp-opt" :class="{active: theme === 'night'}" @click="setTheme('night')">Ночная</div>
                    <div class="rp-opt" :class="{active: theme === 'sand'}" @click="setTheme('sand')">Песочная</div>
                </div>
                <div class="row items-center reader-panel-row">
                    <span class="reader-panel-label">Шрифт</span>
                    <div class="rp-opt" :class="{active: fontFam === 'sans'}" @click="setFontFam('sans')">Без засечек</div>
                    <div class="rp-opt" :class="{active: fontFam === 'serif'}" @click="setFontFam('serif')">С засечками</div>
                </div>
                <div class="row items-center reader-panel-row">
                    <span class="reader-panel-label">Размер</span>
                    <div class="rp-opt" @click="changeFontSize(-1)">A−</div>
                    <span class="reader-panel-size">{{ fontSize }}</span>
                    <div class="rp-opt" @click="changeFontSize(1)">A+</div>
                </div>
                <div class="row items-center reader-panel-row">
                    <span class="reader-panel-label">Режим</span>
                    <div class="rp-opt" :class="{active: mode === 'scroll'}" @click="setMode('scroll')">Прокрутка</div>
                    <div class="rp-opt" :class="{active: mode === 'page'}" @click="setMode('page')">Листание</div>
                </div>
                <div class="row items-center reader-panel-row">
                    <div class="rp-opt rp-danger" @click="removeFromDevice">
                        <i class="la la-trash rp-icon" />Удалить книгу с устройства
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import DivBtn from '../share/DivBtn.vue';
import {parseFb2} from './reader/fb2Reader';
import {parseEpub} from './reader/epubReader';
import * as readerStorage from './reader/readerStorage';

const SETTINGS_KEY = 'inpx-reader-settings';
const HIDE_DELAY = 3500; //мс бездействия, через которые интерфейс скрывается

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
    offsetFrac = 0;
    downloadLoaded = 0;
    downloadTotal = 0;
    meta = null;

    //настройки интерфейса читалки (сохраняются на устройстве)
    theme = 'day'; //day | night | sand
    fontFam = 'sans'; //sans | serif
    fontSize = 18;
    mode = 'scroll'; //scroll | page

    uiVisible = true;
    panelOpen = false;

    sectionTops = [];
    sectionHeights = [];
    touchX = 0;
    touchY = 0;
    touching = false;
    touchEndTimer = null;
    lastScrollTop = 0;
    pageJump = false; //программное листание страниц
    pageJumpTimer = null;
    active = false; //keep-alive: компонент сейчас на экране

    scrollSaveTimer = null;
    lastOffsetUpdate = 0;
    hideTimer = null;
    loadToken = 0;

    get profile() {
        return (this.$store.state.settings.tileProfile || '');
    }

    get currentSection() {
        return (this.book && this.book.sections[this.sectionIndex]) || null;
    }

    get contentFontClass() {
        return (this.fontFam === 'serif' ? 'reader-content-serif' : '');
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
        this.loadSettings();
        window.addEventListener('pagehide', this.onPageHide);
        document.addEventListener('visibilitychange', this.onVisChange);
        window.addEventListener('keydown', this.onKeydown);
        window.addEventListener('resize', this.onResize);
        //скроллится сам документ: слушаем окно, а не внутреннюю полосу
        window.addEventListener('scroll', this.onDocScroll, {passive: true});
        this.load();
    }

    activated() {
        this.active = true;
        //читалка переводит приложение в режим документного скролла
        document.documentElement.classList.add('inpx-reader-doc');
        if (this.phase === 'ready') {
            this.lastScrollTop = this.docScrollY();
            this.$nextTick(() => {
                this.computeMetrics();
                this.restoreScroll();
                this.showUi();
            });
        }
    }

    deactivated() {
        this.active = false;
        this.clearHideTimer();
        if (this.touchEndTimer) {
            clearTimeout(this.touchEndTimer);
            this.touchEndTimer = null;
        }
        this.uiVisible = false;
        document.documentElement.classList.remove('inpx-reader-doc');
    }

    beforeRouteLeave() {
        this.flushProgress();
    }

    beforeUnmount() {
        window.removeEventListener('pagehide', this.onPageHide);
        document.removeEventListener('visibilitychange', this.onVisChange);
        window.removeEventListener('keydown', this.onKeydown);
        window.removeEventListener('resize', this.onResize);
        window.removeEventListener('scroll', this.onDocScroll);
        document.documentElement.classList.remove('inpx-reader-doc');
        this.clearScrollTimer();
        this.clearHideTimer();
        this.flushProgress();
        this.revokeImageUrls();
    }

    reload() {
        this.revokeImageUrls();
        this.uid = this.$route.params.uid || '';
        this.load();
    }

    //---настройки интерфейса-----------------------------------------------------

    loadSettings() {
        let s = {};
        try {
            s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        } catch (e) {
            s = {};
        }
        if (!s.fontSize) {
            const old = parseInt(localStorage.getItem('inpx-reader-fontSize'), 10);
            if (old)
                s.fontSize = old;
        }
        this.theme = ['day', 'night', 'sand'].includes(s.theme) ? s.theme : 'day';
        this.fontFam = (s.fontFam === 'serif') ? 'serif' : 'sans';
        this.fontSize = Math.max(12, Math.min(32, parseInt(s.fontSize, 10) || 18));
        this.mode = (s.mode === 'page' || s.mode === 'scroll') ? s.mode : 'scroll';
    }

    saveSettings() {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            theme: this.theme,
            fontFam: this.fontFam,
            fontSize: this.fontSize,
            mode: this.mode,
        }));
    }

    setTheme(t) {
        if (t === this.theme)
            return;
        this.theme = t;
        this.saveSettings();
    }

    setFontFam(f) {
        if (f === this.fontFam)
            return;
        this.fontFam = f;
        this.saveSettings();
    }

    setMode(m) {
        if (m === this.mode)
            return;
        this.mode = m;
        this.saveSettings();
    }

    changeFontSize(delta) {
        this.fontSize = Math.max(12, Math.min(32, this.fontSize + delta * 2));
        this.saveSettings();
        if (this.phase === 'ready')
            this.$nextTick(() => this.computeMetrics());
    }

    openPanel() {
        this.panelOpen = true;
        this.uiVisible = true;
        this.clearHideTimer();
    }

    closePanel() {
        this.panelOpen = false;
        this.showUi();
    }

    //---авто-скрытие интерфейса---------------------------------------------------
    //на десктопе интерфейс показывается при движении указателя;
    //на тач-устройствах прокрутка «вниз» (к началу книги) показывает
    //интерфейс, чтение (контент вверх) — прячет, а листание страниц
    //строку не трогает вовсе (см. onDocScroll);
    //тап, свайп, колесо и клавиатура показ не запускают

    showUi() {
        this.uiVisible = true;
        this.clearHideTimer();
        if (this.phase === 'ready' && !this.panelOpen)
            this.hideTimer = setTimeout(() => {
                this.hideTimer = null;
                this.uiVisible = false;
            }, HIDE_DELAY);
    }

    hideUiNow() {
        this.clearHideTimer();
        if (!this.panelOpen)
            this.uiVisible = false;
    }

    onUiActivity(e) {
        //синтетические мышиные события после касания — не активность:
        //на тач-устройствах показ меню ведёт onDocScroll
        if (e && e.pointerType === 'touch')
            return;
        if (!this.panelOpen)
            this.showUi();
    }

    clearHideTimer() {
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
    }

    toggleUi() {
        this.uiVisible ? this.hideUiNow() : this.showUi();
    }

    //---загрузка книги------------------------------------------------------------

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
        this.sectionTops = [];
        this.sectionHeights = [];
        this.lastScrollTop = this.docScrollY();
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
            this.showUi();
            this.$nextTick(() => {
                this.computeMetrics();
                this.restoreScroll();
            });
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

    //---положение и прогресс------------------------------------------------------

    //позиции и высоты всех разделов относительно контейнера
    computeMetrics() {
        const el = this.$refs.content;
        this.sectionTops = [];
        this.sectionHeights = [];
        if (!el)
            return;
        for (const s of el.querySelectorAll('.reader-section')) {
            this.sectionTops.push(s.offsetTop);
            this.sectionHeights.push(s.offsetHeight);
        }
    }

    //текущая позиция скролла документа
    docScrollY() {
        return window.scrollY || document.documentElement.scrollTop || 0;
    }

    restoreScroll() {
        const el = this.$refs.content;
        if (!el || !this.sectionTops.length)
            return;
        const i = Math.max(0, Math.min(this.sectionTops.length - 1, this.sectionIndex));
        //цель в координатах документа: верх полосы + раздел + смещение в нём
        //минус точка чтения (30% высоты вьюпорта)
        const contentTop = el.getBoundingClientRect().top + this.docScrollY();
        const target = contentTop + this.sectionTops[i]
            + (this.offsetFrac || 0) * (this.sectionHeights[i] || 0)
            - window.innerHeight * 0.3;
        this.markPageJump();
        window.scrollTo(0, Math.max(0, target));
        this.lastScrollTop = this.docScrollY();
    }

    makeProgress() {
        if (!this.book)
            return null;
        return {
            section: this.sectionIndex + 1,
            total: this.book.total,
            frac: this.offsetFrac,
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

    //прокрутка самого документа (полоса текста уже не скроллится отдельно)
    onDocScroll() {
        if (!this.active || this.phase !== 'ready')
            return;
        const el = this.$refs.content;
        if (!el)
            return;

        const y = this.docScrollY();

        //на тач-устройствах: прокрутка «вниз» (к началу книги, контент идёт
        //вниз) показывает интерфейс, чтение (контент вверх) — прячет;
        //при листании страниц строка не меняется вовсе
        if (this.touching && !this.pageJump) {
            const delta = y - this.lastScrollTop;
            if (delta < -6)
                this.showUi();
            else if (delta > 6)
                this.hideUiNow();
        }
        this.lastScrollTop = y;

        const now = Date.now();
        if (now - this.lastOffsetUpdate > 200) {
            this.lastOffsetUpdate = now;
            //текущий раздел — тот, что содержит точку чтения:
            //30% высоты вьюпорта в координатах полосы текста
            const y0 = window.innerHeight * 0.3 - el.getBoundingClientRect().top;
            let i = 0;
            for (let k = 0; k < this.sectionTops.length; k++)
                if (y0 >= this.sectionTops[k])
                    i = k;
            this.sectionIndex = i;
            const h = this.sectionHeights[i] || 1;
            this.offsetFrac = Math.max(0, Math.min(1, (y0 - this.sectionTops[i]) / h));
        }

        if (!this.scrollSaveTimer)
            this.scrollSaveTimer = setTimeout(() => {
                this.scrollSaveTimer = null;
                this.saveProgressLocal();
            }, 2000);
    }

    //помечаем программное листание: его прыжок тоже вызывает событие
    //скролла, но интерфейс при нём трогать не положено
    markPageJump() {
        this.pageJump = true;
        if (this.pageJumpTimer)
            clearTimeout(this.pageJumpTimer);
        this.pageJumpTimer = setTimeout(() => {
            this.pageJumpTimer = null;
            this.pageJump = false;
        }, 350);
    }

    //---ввод: клавиши, тапы, свайпы---------------------------------------------
    //«страница» = один экран (вьюпорт), строка — высота строки текста

    movePage(d) {
        if (this.phase !== 'ready')
            return;
        const ph = window.innerHeight;
        if (!ph)
            return;
        const max = Math.max(0, document.documentElement.scrollHeight - ph);
        const cur = this.docScrollY();
        //в режиме листания прыгаем на границу ближайшей страницы,
        //в прокрутке — на полный экран от текущей позиции
        const target = (this.mode === 'page')
            ? (Math.round(cur / ph) + d) * ph
            : cur + d * ph;
        this.markPageJump();
        window.scrollTo(0, Math.max(0, Math.min(max, target)));
    }

    moveLine(d) {
        const el = this.$refs.content;
        const lh = (el ? parseFloat(getComputedStyle(el).lineHeight) : 0);
        const step = (isFinite(lh) && lh > 0) ? lh : this.fontSize * 1.65;
        const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo(0, Math.max(0, Math.min(max, this.docScrollY() + d * step)));
    }

    onKeydown(e) {
        if (this.panelOpen) {
            if (e.key === 'Escape')
                this.closePanel();
            return;
        }
        if (this.phase !== 'ready')
            return;
        //клавиатура не показывает интерфейс
        switch (e.key) {
            case 'ArrowRight':
            case 'PageDown':
            case ' ':
                e.preventDefault();
                this.movePage(1);
                break;
            case 'ArrowLeft':
            case 'PageUp':
                e.preventDefault();
                this.movePage(-1);
                break;
            case 'ArrowDown':
                e.preventDefault();
                this.moveLine(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.moveLine(-1);
                break;
        }
    }

    //тап-зоны (режим листания): левая треть — назад, правая — дальше, центр — интерфейс
    onPageTap(e) {
        if (this.mode !== 'page' || this.panelOpen || this.phase !== 'ready')
            return;
        const t = e.target;
        if (t && t.closest && t.closest('a'))
            return; //ссылки в тексте — не листаем
        const el = this.$refs.content;
        if (!el)
            return;
        const rect = el.getBoundingClientRect();
        const w = rect.width || 1;
        const x = e.clientX - rect.left;
        if (x < w * 0.3)
            this.movePage(-1);
        else if (x > w * 0.7)
            this.movePage(1);
        else
            this.toggleUi();
    }

    onTouchStart(e) {
        if (this.touchEndTimer) {
            clearTimeout(this.touchEndTimer);
            this.touchEndTimer = null;
        }
        const t = e.touches[0];
        if (t) {
            this.touchX = t.clientX;
            this.touchY = t.clientY;
        }
        this.touching = true;
    }

    onTouchEnd(e) {
        //даём время на инерционную прокрутку после отрыва пальца
        if (this.touchEndTimer)
            clearTimeout(this.touchEndTimer);
        this.touchEndTimer = setTimeout(() => {
            this.touchEndTimer = null;
            this.touching = false;
        }, 600);
        if (this.mode !== 'page' || this.phase !== 'ready')
            return;
        const t = e.changedTouches[0];
        if (!t)
            return;
        const dx = t.clientX - this.touchX;
        const dy = t.clientY - this.touchY;
        //свайп: сильнее 60px и горизонталь доминирует
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
            if (dx < 0)
                this.movePage(1);
            else
                this.movePage(-1);
        }
    }

    onResize() {
        if (this.phase === 'ready')
            this.computeMetrics();
    }

    onPageHide() {
        this.flushProgress();
    }

    onVisChange() {
        if (document.visibilityState === 'hidden')
            this.flushProgress();
    }

    //---прочее---------------------------------------------------------------------

    async removeFromDevice() {
        this.panelOpen = false;
        const ok = await this.$root.stdDialog.confirm(
            'Удалить книгу и прогресс с этого устройства?',
            'Удаление с устройства',
        );
        if (!ok) {
            this.showUi();
            return;
        }

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
/*корень читалки лежит в потоке документа: именно документ
  скроллится, а не внутренняя полоса текста — иначе мобильный
  браузер не меняет состояние адресной строки*/
.reader-root {
    min-height: 100vh;
    background: var(--r-bg);
    color: var(--r-text);
    font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

/*темы: дневная / ночная / песочная*/
.theme-day {
    --r-bg: #ffffff;
    --r-text: #1c1c1c;
    --r-bar: #f7f7f7;
    --r-border: #e0e0e0;
    --r-muted: #666666;
    --r-accent: #1976d2;
    --r-soft: #f2f2f2;
}
.theme-night {
    --r-bg: #101418;
    --r-text: #c9cdd3;
    --r-bar: #161b20;
    --r-border: #272e36;
    --r-muted: #8b939c;
    --r-accent: #8ab4ff;
    --r-soft: #1b2127;
}
.theme-sand {
    --r-bg: #f4ecd8;
    --r-text: #3d3427;
    --r-bar: #ece1c6;
    --r-border: #d8c89f;
    --r-muted: #7c6f56;
    --r-accent: #8a6d3b;
    --r-soft: #eaddbe;
}

/*верхний HUD: верхняя панель + линия прогресса, прижат к верху вьюпорта
  и лежит поверх прокручиваемого документа*/
.reader-hud-top {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    transition: transform 0.3s ease, opacity 0.3s ease;
}

.reader-hud-top.off {
    transform: translateY(-100%);
    opacity: 0;
    pointer-events: none;
}

.reader-topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--r-border);
    background: var(--r-bar);
    min-height: 48px;
}

.reader-back {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    color: var(--r-text);
    white-space: nowrap;
    text-decoration: none;
    font-size: 13px;
}

.reader-back:hover {
    color: var(--r-accent);
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
    color: var(--r-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/*позиция в книге — в верхнем баре, после названия*/
.reader-title-pos {
    font-size: 11px;
    color: var(--r-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.reader-font-btn {
    font-size: 12px;
}

.reader-progress-line {
    height: 3px;
    background: var(--r-border);
}

.reader-progress-fill {
    height: 100%;
    background: var(--r-accent);
    transition: width 0.2s linear;
}

/*текст книги: отступ сверху под HUD; скроллится документ, а не полоса*/
.reader-content {
    position: relative;
    padding: 80px 16px 24px 16px;
    line-height: 1.65;
    /*отключаем выбор по одиночному тапу (с вызовом меню поиска
      на iOS/Android); выделение по двум тапам и удержанию
      остаётся — браузер разрешает override по user-select*/
    -webkit-user-select: none;
    user-select: none;
}

.reader-content-serif {
    font-family: Georgia, 'Times New Roman', 'PT Serif', serif;
}

.reader-content-inner {
    max-width: 720px;
    margin: 0 auto;
}

.reader-section {
    margin: 0 0 2em 0;
}

.reader-section-title {
    font-size: 1.4em;
    font-weight: 600;
    margin: 8px 0 16px 0;
    color: var(--r-text);
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
    color: var(--r-text);
}

.reader-section-html .fb2-epigraph,
.reader-section-html .fb2-annotation,
.reader-section-html .fb2-block {
    margin: 1em 0;
    padding: 0 12px;
    color: var(--r-muted);
}

.reader-section-html img {
    max-width: 100%;
    display: block;
    margin: 1em auto;
}

.reader-section-html blockquote {
    margin: 1em 0;
    padding-left: 16px;
    border-left: 3px solid var(--r-border);
    color: var(--r-muted);
}

.reader-section-html a {
    color: var(--r-accent);
}

.reader-section-html pre {
    background: var(--r-soft);
    padding: 8px;
    overflow-x: auto;
}

.reader-status {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    gap: 12px;
    color: var(--r-muted);
}

.reader-status-msg {
    font-size: 15px;
}

.reader-status-sub {
    font-size: 13px;
    color: var(--r-muted);
}

.reader-progress-bar {
    width: 80%;
    max-width: 320px;
    height: 8px;
    border-radius: 4px;
    background: var(--r-border);
    overflow: hidden;
}

.reader-link {
    color: var(--r-accent);
    text-decoration: none;
    font-size: 14px;
}

.reader-link:hover {
    text-decoration: underline;
}

/*панель настроек: шторка снизу, прижата к вьюпорту*/
.reader-panel-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 20;
}

.reader-panel {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    background: var(--r-bar);
    border-top: 1px solid var(--r-border);
    border-radius: 12px 12px 0 0;
    transform: translateY(100%);
    transition: transform 0.25s ease;
    max-height: 70%;
    overflow-y: auto;
}

.reader-panel.open {
    transform: translateY(0);
}

.reader-panel-head {
    padding: 10px 12px;
    border-bottom: 1px solid var(--r-border);
}

.reader-panel-title {
    font-size: 14px;
    font-weight: 600;
}

.rp-close {
    cursor: pointer;
    font-size: 18px;
    color: var(--r-muted);
    padding: 0 4px;
}

.rp-close:hover {
    color: var(--r-text);
}

.reader-panel-body {
    padding: 8px 12px calc(12px + env(safe-area-inset-bottom)) 12px;
}

.reader-panel-row {
    margin: 8px 0;
    gap: 8px;
}

.reader-panel-label {
    font-size: 13px;
    color: var(--r-muted);
    min-width: 64px;
}

.reader-panel-size {
    font-size: 13px;
    color: var(--r-muted);
    min-width: 20px;
    text-align: center;
}

.rp-opt {
    padding: 5px 12px;
    border: 1px solid var(--r-border);
    border-radius: 14px;
    font-size: 13px;
    color: var(--r-text);
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
}

.rp-opt:hover {
    border-color: var(--r-muted);
}

.rp-opt.active {
    background: var(--r-accent);
    border-color: var(--r-accent);
    color: #fff;
}

.rp-danger {
    color: #c62828;
    border-color: #c62828;
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.rp-icon {
    font-size: 12px;
}
</style>

<style>
/*читалка лежит в потоке документа: пока активен маршрут читалки,
  снимаем фиксированные высоты контейнеров приложения — именно тогда
  документ прокручивается, и мобильный браузер нативно прячет
  адресную строку при чтении и открывает её при прокрутке «вниз»*/
html.inpx-reader-doc,
html.inpx-reader-doc body,
html.inpx-reader-doc #app {
    height: auto !important;
}

html.inpx-reader-doc .fit {
    height: auto !important;
}

html.inpx-reader-doc {
    overscroll-behavior: none;
}
</style>
