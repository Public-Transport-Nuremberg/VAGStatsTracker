class StoreBenchmark {
    constructor(storeClasses, { maxKeys, metricsEvery }) {
        this.storeClasses = storeClasses;
        this.maxKeys = maxKeys;
        this.metricsEvery = metricsEvery;
    }

    async run() {
        for (let StoreClass of this.storeClasses) {
            console.log(`\nBenchmarking ${StoreClass.name}`);

            // Initialize store
            const store = new StoreClass();
            await store.init(); // Assuming async initialization is required
            const keys = store.getKeysAmount(); // Retrieve all available keys

            // Benchmark get() using random keys from the store
            if(store.getasyncNature) {
                let readIterSec = await this.asyncbenchmarkGet(store, keys, this.maxKeys, this.metricsEvery);
                console.log(`${StoreClass.name} with ${store.length()} key - Average Reads/sec: ${this.short_num(readIterSec)}`);
                continue;
            }
            let readIterSec = this.benchmarkGet(store, keys, this.maxKeys, this.metricsEvery);
            console.log(`${StoreClass.name} with ${store.length()} key - Average Reads/sec: ${this.short_num(readIterSec)}`);
        }
    }

    short_num(num) {
        // shorten number to K/M/B
        if (num >= 1000000000) num = '' + Math.floor(num / 1000000000) + 'B';
        else if (num >= 1000000) num = '' + Math.floor(num / 1000000) + 'M';
        else if (num >= 1000) num = '' + Math.floor(num / 1000) + 'K';
        return num;
    };

    benchmarkGet = (store, keys, maxKeys, metricsEvery) => {
        let totalDuration = 0;
        let operations = 0;

        for (let i = 0; i < maxKeys; i++) {
            const randomKeyIndex = Math.floor(Math.random() * keys.length);
            const key = keys[randomKeyIndex];

            let start = process.hrtime.bigint();
            const keyData = store.get(key);
            let end = process.hrtime.bigint();

            totalDuration += Number(end - start); // Convert to number
            operations++;

            if (operations % metricsEvery === 0) {
                const durationSeconds = totalDuration / 1e9; // Convert nanoseconds to seconds
                const readsPerSec = Math.floor(operations / durationSeconds);
                console.log(`At ${operations} reads: ${this.short_num(readsPerSec)} Reads/sec`);
            }
        }

        const totalDurationSeconds = totalDuration / 1e9; // Convert nanoseconds to seconds for total
        return Math.floor(operations / totalDurationSeconds);
    }

    asyncbenchmarkGet = async (store, keys, maxKeys, metricsEvery) => {
        let totalDuration = 0;
        let operations = 0;

        for (let i = 0; i < maxKeys; i++) {
            const randomKeyIndex = Math.floor(Math.random() * keys.length);
            const key = keys[randomKeyIndex];
            const asyncTemp = []
            let start = process.hrtime.bigint();
            asyncTemp.push(store.get(key));
            await Promise.all(asyncTemp);
            let end = process.hrtime.bigint();

            totalDuration += Number(end - start); // Convert to number
            operations++;

            if (operations % metricsEvery === 0) {
                const durationSeconds = totalDuration / 1e9; // Convert nanoseconds to seconds
                const readsPerSec = Math.floor(operations / durationSeconds);
                console.log(`At ${operations} reads: ${this.short_num(readsPerSec)} Reads/sec`);
            }
        }

        const totalDurationSeconds = totalDuration / 1e9; // Convert nanoseconds to seconds for total
        return Math.floor(operations / totalDurationSeconds);
    }
}

module.exports = StoreBenchmark;