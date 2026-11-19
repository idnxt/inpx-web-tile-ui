<template>
    <div class="tile-card" @click.stop.prevent="open">
        <div class="tile-cover">
            <img v-if="cover" :src="cover" alt="" loading="lazy" />
            <div v-else class="tile-cover-ph">
                <i class="la la-book text-grey-5" style="font-size: 40px" />
            </div>
            <div v-if="label" class="tile-label">{{ label }}</div>
        </div>
        <div class="tile-meta">
            <div class="tile-title">{{ book.title }}</div>
            <a v-if="book.authorId && authorName" class="tile-author tile-author-link" :href="authorLink" @click.stop>{{ authorName }}</a>
            <div v-else class="tile-author">{{ authorName }}</div>
            <div class="tile-bottom">
                <span class="tile-year">{{ book.year }}</span>
                <span v-if="book.librate" class="tile-rate">
                    <TileStars :rating="book.librate" />
                </span>
            </div>
        </div>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import TileStars from './TileStars.vue';

const componentOptions = {
    components: {
        TileStars,
    },
};
class TileCard {
    _options = componentOptions;
    _props = {
        book: {type: Object, required: true},
        cover: {type: String, default: ''},
        label: {type: String, default: ''},
        link: {type: String, default: ''},
    };

    get authorName() {
        return (this.book.author ? this.book.author.split(',')[0] : '');
    }

    get authorLink() {
        return `#/tile/section/author/${this.book.authorId}`;
    }

    open() {
        //uid содержит спецсимволы (+, /, =) — кодируем для маршрута
        this.$router.push(this.link || `/tile/book/${encodeURIComponent(this.book._uid)}`);
    }
}

export default vueComponent(TileCard);
</script>

<style scoped>
.tile-card {
    flex: 0 0 auto;
    width: 150px;
    background: #ffffff;
    border-radius: 6px;
    box-shadow: 1px 2px 6px rgba(0, 0, 0, 0.25);
    cursor: pointer;
    transition: transform 0.15s linear, box-shadow 0.15s linear;
}

.tile-card:hover {
    transform: translateY(-3px);
    box-shadow: 1px 4px 12px rgba(0, 0, 0, 0.35);
}

.tile-cover {
    position: relative;
    width: 150px;
    height: 200px;
    background: #e0e0e0;
    overflow: hidden;
    border-radius: 6px 6px 0 0;
}

.tile-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.tile-cover-ph {
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
}

.tile-label {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.65);
    color: #ffffff;
    font-size: 11px;
    line-height: 1.3;
    padding: 2px 5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.tile-meta {
    padding: 6px 7px 7px 7px;
    font-size: 12px;
}

.tile-title {
    line-height: 15px;
    height: 30px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.tile-author {
    display: block;
    margin-top: 3px;
    line-height: 15px;
    height: 15px;
    color: #666666;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

a.tile-author-link {
    text-decoration: none;
    color: #1976d2;
}

a.tile-author-link:hover {
    text-decoration: underline;
}

.tile-bottom {
    margin-top: 4px;
    display: flex;
    justify-content: space-between;
    color: #888888;
    font-size: 11px;
}

</style>
