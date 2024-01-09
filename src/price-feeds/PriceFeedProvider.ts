import { randomInt } from "crypto";

export class PriceFeedProvider {
    public numFeeds: number;
    constructor(numFeeds: number) {
        if (numFeeds > 64) {
            throw new Error("Number of feeds should be at most 64.");
        }
        this.numFeeds = numFeeds;
    }

    getFeed(): [string[], string] {
        let feeds: string = "";
        let feed = 0;
        for (let i = 0; i < this.numFeeds; i++) {
            if (i % 2 == 0) {
                feed = 0;
            }
            const n = randomInt(3);
            if (i % 2 == 0) {
                if (n == 1) {
                    feed += 1;
                }
                if (n == 2) {
                    feed += 3;
                }
            } else {
                if (n == 1) {
                    feed += 4;
                }
                if (n == 2) {
                    feed += 12;
                }
                feeds = feeds + feed.toString(16);
            }
        }
        feeds = feeds + "0".repeat(64 - feeds.length);

        const delta1 = "0x" + "0".repeat(64);
        const delta2 = "0x" + "0".repeat(52);
        const deltas: [string[], string] = [["0x" + feeds, delta1, delta1, delta1, delta1, delta1, delta1], delta2];

        return deltas;
    }
}