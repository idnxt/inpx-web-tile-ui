<template>
    <span class="tile-stars" :style="{fontSize: `${size}px`}">
        <q-tooltip v-if="rating" :delay="800" content-style="font-size: 80%">{{ rating }}</q-tooltip>
        <template v-for="(s, i) in stars" :key="i">
            <span v-if="s === 'half'" class="tile-star-half">
                <i class="la la-star-o text-yellow-7" />
                <span class="tile-star-half-fill"><i class="la la-star text-yellow-7" /></span>
            </span>
            <i v-else :class="s" />
        </template>
    </span>
</template>

<script>
import vueComponent from '../vueComponent.js';

class TileStars {
    _options = {};
    _props = {
        rating: {type: Number, default: 0},
        size: {type: Number, default: 11},
    };

    get stars() {
        const half = Math.round((this.rating || 0) * 2) / 2;
        const full = Math.floor(half);
        const hasHalf = (half - full) >= 0.5;

        const result = [];
        for (let i = 0; i < 5; i++) {
            if (i < full)
                result.push('la la-star text-yellow-7');
            else if (i === full && hasHalf)
                result.push('half');
            else
                result.push('la la-star-o text-grey-4');
        }

        return result;
    }
}

export default vueComponent(TileStars);
</script>

<style scoped>
.tile-stars {
    display: inline-flex;
    align-items: center;
    line-height: 1;
}

.tile-star-half {
    position: relative;
    display: inline-block;
}

.tile-star-half i {
    display: inline-block;
}

.tile-star-half-fill {
    position: absolute;
    left: 0;
    top: 0;
    width: 50%;
    overflow: hidden;
}
</style>
