<template>
    <div class="tile-root">
        <LoadingMessage :message="loadingMessage" />

        <div class="tile-topbar">
            <TileSearchBar />
        </div>

        <div v-if="error" class="text-red q-pa-md">
            {{ error }}
        </div>
        <div v-else-if="book" class="tile-book">
            <div class="tile-book-left">
                <div class="tile-cover-big">
                    <img v-if="cover" :src="cover" alt="" />
                    <div v-else class="tile-cover-big-ph">
                        <i class="la la-book text-grey-5" style="font-size: 60px" />
                    </div>
                </div>
                <div v-if="seriesBooks.length" class="tile-series-books" :class="{'tile-series-books-limit': seriesBooks.length > 30}">
                    <a
                        v-for="s in seriesBooks"
                        :key="s.uid"
                        :href="bookLink(s.uid)"
                        class="tile-series-book"
                        :class="{'tile-series-book-cur': s.uid === book._uid}"
                    >
                        {{ s.serno ? `${s.serno}. ` : '' }}{{ s.title }}<span v-if="s.year" class="tile-series-book-year"> ({{ s.year }})</span>
                    </a>
                </div>
            </div>
            <div class="col">
                <div class="tile-book-title">{{ book.title }}</div>
                <a v-if="book.author && book.authorId" class="tile-book-author" :href="authorLink" @click.stop>{{ book.author }}</a>
                <div v-else-if="book.author" class="tile-book-author">{{ book.author }}</div>
                <div class="row items-center q-mt-sm">
                    <span v-if="book.year" class="tile-book-year">{{ book.year }}</span>
                    <span v-if="book.librate" class="tile-rate-big">
                        <TileStars :rating="book.librate" :size="14" />
                    </span>
                    <span v-if="book.lang" class="q-ml-md text-grey-7">{{ book.lang }}</span>
                </div>
                <div v-if="genres.length" class="q-mt-md">
                    <span class="text-grey-7 q-mr-xs">Жанры:</span>
                    <a
                        v-for="(g, i) in genres"
                        :key="`genre-${i}`"
                        :href="genreLink(g.code)"
                        class="tile-genre"
                    >{{ g.name }}</a>
                </div>
                <div v-if="book.series" class="q-mt-sm">
                    <span class="text-grey-7 q-mr-xs">Серия:</span>
                    <a :href="seriesLink" class="tile-genre">{{ book.series }}</a>
                    <span v-if="book.serno" class="text-grey-7">{{ book.serno }}</span>
                </div>
                <div class="row q-mt-lg">
                    <DivBtn size="32" icon="la la-download" :disabled="loading" @meClick="download">Скачать</DivBtn>
                </div>

                <div v-if="annotation" class="tile-annotation q-mt-lg" v-html="annotation" />

                <div v-if="infoList.length" class="q-mt-md">
                    <div v-for="item in infoList" :key="item.name" class="tile-info-block">
                        <div class="tile-info-head">{{ item.label }}</div>
                        <div v-for="sub in item.value" :key="sub.name" class="row tile-info-row">
                            <div class="tile-info-label">{{ sub.label }}</div>
                            <div class="col tile-info-value" v-html="sub.value" />
                        </div>
                    </div>
                </div>

                <div class="tile-reviews q-mt-lg">
                    <div class="tile-block-head">Рецензии</div>
                    <div v-if="reviewsLoading" class="tile-block-note">Загрузка рецензий...</div>
                    <div v-else-if="reviewsDisabled" class="tile-block-note">Рецензии недоступны</div>
                    <div v-else-if="reviewsError" class="text-red">{{ reviewsError }}</div>
                    <template v-else-if="reviews.foundCount > 0">
                        <div class="tile-block-note">
                            Рецензий: <b>{{ reviews.foundCount }}</b>,
                            оценок: <b>{{ reviews.declaredCount }}</b>
                            <span v-if="avgRating">, средняя: <b>{{ avgRating }}</b></span>
                        </div>
                        <div v-for="(review, i) in reviews.reviews" :key="i" class="tile-review">
                            <div class="tile-review-meta">{{ review.name || 'Аноним' }} — {{ review.time }}</div>
                            <div class="tile-review-text" v-html="review.text" />
                        </div>
                    </template>
                    <div v-else class="tile-block-note">Рецензии не найдены</div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import LoadingMessage from '../Search/LoadingMessage/LoadingMessage.vue';
import DivBtn from '../share/DivBtn.vue';
import TileStars from './TileStars.vue';
import TileSearchBar from './TileSearchBar.vue';
import {buildInfoList} from '../../../server/core/book/bookInfoMapping';

const componentOptions = {
    components: {
        LoadingMessage,
        DivBtn,
        TileStars,
        TileSearchBar,
    },
    watch: {
        $route() {
            this.load();
        },
    },
};
class TileBook {
    _options = componentOptions;

    book = null;
    cover = '';
    genres = [];
    genreMap = new Map();
    seriesBooks = [];
    loadingMessage = '';
    error = '';

    loadToken = 0;
    annotation = '';
    infoList = [];
    reviewsLoading = false;
    reviewsDisabled = false;
    reviewsError = '';
    reviews = {declaredCount: 0, sum: 0, foundCount: 0, reviews: []};

    get loading() {
        return !!this.loadingMessage;
    }

    get avgRating() {
        if (!this.reviews.declaredCount)
            return '';
        return (this.reviews.sum / this.reviews.declaredCount).toFixed(1);
    }

    created() {
        this.api = this.$root.api;
    }

    mounted() {
        this.load();
    }

    async load() {
        if (!this.$route.path.startsWith('/tile/book/'))
            return;

        const uid = this.$route.params.uid;
        if (!uid) {
            this.$router.replace('/tile');
            return;
        }

        this.loadingMessage = 'Загрузка...';
        this.error = '';
        this.book = null;
        this.cover = '';
        this.genres = [];
        this.seriesBooks = [];
        this.annotation = '';
        this.infoList = [];
        this.reviewsLoading = false;
        this.reviewsError = '';
        this.reviews = {declaredCount: 0, sum: 0, foundCount: 0, reviews: []};

        const token = ++this.loadToken;
        try {
            const result = await this.api.getTileBook(uid);
            if (token !== this.loadToken)
                return;

            this.book = result.book;
            this.cover = (result.cover || '');
            this.seriesBooks = (result.seriesBooks || []);
            await this.makeGenres();
            this.loadExtra(uid, token);
        } catch (e) {
            this.error = e.message;
        } finally {
            if (token === this.loadToken)
                this.loadingMessage = '';
        }
    }

    async makeGenres() {
        if (!this.book || !this.book.genre) {
            this.genres = [];
            return;
        }

        if (!this.genreMap.size) {
            try {
                const tree = await this.api.getGenreTree();
                const map = new Map();
                for (const section of tree.genreTree)
                    for (const g of section.value)
                        map.set(g.value, g.name);
                this.genreMap = map;
            } catch (e) {
                //не критично
            }
        }

        this.genres = this.book.genre.split(',')
            .map((code) => code.trim())
            .filter((code) => code)
            .map((code) => ({code, name: (this.genreMap.get(code) || code)}));
    }

    genreLink(code) {
        return `#/tile/section/genre/${encodeURIComponent(code)}`;
    }

    get seriesLink() {
        return `#/tile/section/series/${encodeURIComponent(this.book.series)}`;
    }

    bookLink(uid) {
        return `#/tile/book/${encodeURIComponent(uid)}`;
    }

    async download() {
        try {
            this.loadingMessage = 'Подготовка файла...';
            const response = await this.api.getBookLink(this.book._uid);
            window.open(`${window.location.origin}${response.link}`, '_blank');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        } finally {
            this.loadingMessage = '';
        }
    }

    get authorLink() {
        return `#/tile/section/author/${this.book.authorId}`;
    }

    convertGenres(value) {
        const codes = (typeof value === 'string' ? value.split(',') : (value || []));
        return codes.map((c) => (this.genreMap.get(String(c).trim()) || String(c).trim())).join(', ');
    }

    async loadExtra(uid, token) {
        const features = ((this.$store.state.config || {}).features || {});

        if (features.reviewsEnabled) {
            this.reviewsDisabled = false;
            this.reviewsLoading = true;
            this.api.getBookReviews(uid)
                .then((res) => {
                    if (token === this.loadToken)
                        this.reviews = (res || {});
                })
                .catch((e) => {
                    if (token === this.loadToken)
                        this.reviewsError = e.message;
                })
                .finally(() => {
                    if (token === this.loadToken)
                        this.reviewsLoading = false;
                });
        } else {
            this.reviewsDisabled = true;
        }

        try {
            const res = await this.api.getBookInfo(uid);
            if (token !== this.loadToken)
                return;

            const bi = ((res.bookInfo || {}).bookInfo);
            if (!bi)
                return;

            const ti = (bi.titleInfo || {});
            if (ti.annotationHtml)
                this.annotation = ti.annotationHtml.replace(/<p>/g, '<p class="p-annotation">');

            this.infoList = buildInfoList(bi, {
                valueToString: (value, nodePath, origVTS) => {
                    if (nodePath === 'titleInfo/genre' || nodePath === 'srcTitleInfo/genre')
                        return this.convertGenres(value);
                    return origVTS(value, nodePath);
                },
            });
        } catch (e) {
            //инфо не критично
        }
    }
}

export default vueComponent(TileBook);
</script>

<style scoped>
.tile-root {
    position: relative;
    height: 100%;
    overflow: auto;
    background: #f5f5f5;
}

.tile-topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: #e0f2f1;
    padding: 8px 16px;
}

.tile-book {
    display: flex;
    gap: 20px;
    padding: 20px 24px;
    align-items: flex-start;
}

.tile-book-left {
    flex: 0 0 auto;
    width: 240px;
}

.tile-cover-big {
    flex: 0 0 auto;
    width: 240px;
    height: 320px;
    background: #e0e0e0;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 1px 3px 10px rgba(0, 0, 0, 0.3);
}

.tile-cover-big img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.tile-cover-big-ph {
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
}

.tile-book-title {
    font-size: 24px;
    font-weight: bold;
    line-height: 1.3;
}

.tile-book-author {
    margin-top: 6px;
    font-size: 16px;
    color: #555555;
}

a.tile-book-author {
    text-decoration: none;
    color: #1976d2;
}

a.tile-book-author:hover {
    text-decoration: underline;
}

.tile-book-year {
    font-size: 15px;
    color: #666666;
}

.tile-rate-big {
    margin-left: 16px;
    font-size: 15px;
}

.tile-genre {
    display: inline-block;
    margin: 2px 8px 2px 0;
    padding: 2px 8px;
    background: #e3f2fd;
    border-radius: 10px;
    color: #1976d2;
    font-size: 12px;
    text-decoration: none;
}

.tile-genre:hover {
    background: #bbdefb;
}

.tile-series-books {
    width: 240px;
    margin-top: 10px;
    background: #ffffff;
    border-radius: 4px;
    padding: 6px 10px;
}

.tile-series-books-limit {
    max-height: 220px;
    overflow-y: auto;
}

.tile-series-book {
    display: block;
    font-size: 13px;
    line-height: 18px;
    color: #555555;
    text-decoration: none;
}

a.tile-series-book:hover {
    text-decoration: underline;
    color: #1976d2;
}

.tile-series-book-cur {
    font-weight: bold;
    color: #333333;
}

.tile-series-book-year {
    color: #999999;
}

.tile-annotation {
    font-size: 14px;
    line-height: 1.5;
    color: #333333;
    text-indent: 25px;
    text-align: justify;
    background: #ffffff;
    padding: 10px 14px;
    border-radius: 4px;
}

.tile-annotation ::v-deep p {
    margin: 0 0 8px 0;
    text-indent: 25px;
}

.tile-annotation ::v-deep p:last-child {
    margin-bottom: 0;
}

.tile-info-block {
    margin-top: 10px;
}

.tile-info-head {
    font-size: 13px;
    font-weight: bold;
    color: #444444;
    margin-bottom: 2px;
}

.tile-info-row {
    line-height: 18px;
}

.tile-info-label {
    flex: 0 0 150px;
    color: #888888;
    font-size: 12px;
}

.tile-info-value {
    font-size: 12px;
    color: #333333;
    word-break: break-word;
}

.tile-block-head {
    font-size: 16px;
    font-weight: bold;
    color: #333333;
}

.tile-block-note {
    font-size: 12px;
    color: #888888;
    margin-top: 4px;
}

.tile-review {
    margin-top: 10px;
    padding: 8px 12px;
    background: #ffffff;
    border-radius: 4px;
}

.tile-review-meta {
    font-size: 12px;
    color: #888888;
}

.tile-review-text {
    font-size: 13px;
    line-height: 1.5;
    color: #333333;
    margin-top: 4px;
}

.tile-review-text ::v-deep p {
    margin: 0 0 6px 0;
}
</style>
