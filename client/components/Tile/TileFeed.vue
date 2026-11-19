<template>
    <div class="tile-feed q-mb-md">
        <div class="row items-center q-mb-xs">
            <a v-if="titleHref" :href="titleHref" class="tile-feed-title">{{ title }}</a>
            <div v-else class="tile-feed-title">{{ title }}</div>
            <span v-if="suffix" class="tile-feed-suffix">{{ suffix }}</span>
            <template v-for="(g, i) in subgenres" :key="`sub-${i}`">
                <span class="tile-feed-sep">/</span>
                <a :href="`#/tile/section/genre/${encodeURIComponent(g.value)}`" class="tile-feed-sub">{{ g.name }}</a>
            </template>
        </div>
        <div class="tile-row">
            <TileCard
                v-for="c in cards"
                :key="c.book._uid"
                :book="c.book"
                :cover="covers[c.book._uid]"
                :label="c.label"
                :link="c.link"
            />
        </div>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import TileCard from './TileCard.vue';

const componentOptions = {
    components: {
        TileCard,
    },
};
class TileFeed {
    _options = componentOptions;
    _props = {
        title: {type: String, default: ''},
        titleHref: {type: String, default: ''},
        suffix: {type: String, default: ''},
        books: {type: Array, default: () => []},
        covers: {type: Object, default: () => ({})},
        subgenres: {type: Array, default: () => []},
    };

    get cards() {
        //элемент — либо объект книги, либо {book, label, link}
        return this.books.map((b) => (b.book ? b : {book: b}));
    }
}

export default vueComponent(TileFeed);
</script>

<style scoped>
.tile-feed-title {
    font-size: 14px;
    font-weight: bold;
    color: #333333;
}

a.tile-feed-title {
    text-decoration: none;
    color: #1976d2;
}

a.tile-feed-title:hover {
    text-decoration: underline;
}

.tile-feed-suffix {
    font-size: 14px;
    font-weight: bold;
    color: #333333;
}

.tile-feed-sep {
    font-size: 12px;
    color: #999999;
    margin: 0 4px;
}

.tile-feed-sub {
    font-size: 12px;
    color: #1976d2;
    text-decoration: none;
}

.tile-feed-sub:hover {
    text-decoration: underline;
}

.tile-row {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    padding-bottom: 6px;
}
</style>
