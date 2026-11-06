import dotenv from 'dotenv';
import { consola } from 'consola';
import handleNotion from './handle-notion';
import { getDataSourceId, sleep } from './utils';
import { ItemCategory, ItemStatus, type FeedItem } from './types';

dotenv.config();

const DOUBAN_API = 'https://m.douban.com/rexxar/api/v2/user';
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PAGE_SIZE = 20;
const CHUNK_SIZE = 40;
const REQUEST_DELAY_MS = 400;
const MAX_FETCH_ATTEMPTS = 3;

type DoubanInterest = {
  id: number;
  status: string;
  create_time: string;
  comment: string;
  rating: { value: number } | null;
  subject: {
    id: string;
    title: string;
    url: string;
    type: string;
    rating?: { value: number } | null;
  };
};

type InterestsResponse = {
  total: number;
  start: number;
  interests?: DoubanInterest[];
};

// the interest status returned by the mobile API uses `mark` for wishlist
const STATUS_BY_DOUBAN: Record<string, ItemStatus> = {
  done: ItemStatus.Complete,
  doing: ItemStatus.Progress,
  mark: ItemStatus.Wishlist,
  wish: ItemStatus.Wishlist,
};

const STATUS_PRIORITY: Record<string, number> = {
  done: 3,
  doing: 2,
  mark: 1,
  wish: 1,
};

/**
 * Fetches one page of the Douban interests API, retrying transient failures.
 *
 * @param {string} user - the Douban user id
 * @param {string} url - the page URL
 * @param {number} attempt - the current attempt number
 * @return {Promise<InterestsResponse>} the parsed response
 */
async function fetchPage(user: string, url: string, attempt = 1): Promise<InterestsResponse> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: `https://m.douban.com/people/${user}/`,
      },
    });
    if (!response.ok) {
      throw new Error(`Douban responded with HTTP ${response.status}`);
    }
    return (await response.json()) as InterestsResponse;
  } catch (error) {
    if (attempt >= MAX_FETCH_ATTEMPTS) {
      throw error;
    }
    consola.warn(`Douban request failed (attempt ${attempt}), retrying...`, error);
    await sleep(1000 * attempt);
    return fetchPage(user, url, attempt + 1);
  }
}

/**
 * Fetches every interest of one type and status bucket.
 *
 * @param {string} user - the Douban user id
 * @param {string} type - `movie` or `book`
 * @param {string} queryStatus - `done`, `doing` or `wish`
 * @return {Promise<DoubanInterest[]>} all interests in the bucket
 */
async function fetchInterests(
  user: string,
  type: string,
  queryStatus: string,
): Promise<DoubanInterest[]> {
  const interests: DoubanInterest[] = [];
  let start = 0;
  for (;;) {
    const url = `${DOUBAN_API}/${user}/interests?type=${type}&status=${queryStatus}&start=${start}&count=${PAGE_SIZE}&sort=time`;
    const page = await fetchPage(user, url);
    const batch = page.interests ?? [];
    interests.push(...batch);
    if (batch.length === 0 || interests.length >= page.total) {
      break;
    }
    start += batch.length;
    await sleep(REQUEST_DELAY_MS);
  }
  return interests;
}

/**
 * Deduplicates interests by subject, preferring the strongest status
 * (done > doing > wishlist) and the latest mark among equals.
 *
 * @param {DoubanInterest[]} interests - the raw interests
 * @param {ItemCategory} category - the Notion category to map to
 * @return {FeedItem[]} the feed items ready for the Notion sync
 */
function toFeedItems(interests: DoubanInterest[], category: ItemCategory): FeedItem[] {
  const unique = new Map<string, DoubanInterest>();
  for (const interest of interests) {
    const current = unique.get(interest.subject.id);
    if (!current) {
      unique.set(interest.subject.id, interest);
      continue;
    }
    const priority = STATUS_PRIORITY[interest.status] ?? 0;
    const currentPriority = STATUS_PRIORITY[current.status] ?? 0;
    if (
      priority > currentPriority ||
      (priority === currentPriority && interest.create_time > current.create_time)
    ) {
      unique.set(interest.subject.id, interest);
    }
  }

  const feeds: FeedItem[] = [];
  for (const interest of unique.values()) {
    const status = STATUS_BY_DOUBAN[interest.status];
    if (!status) {
      continue;
    }
    feeds.push({
      id: interest.subject.id,
      link: interest.subject.url,
      rating: interest.rating?.value || null,
      doubanRating: interest.subject.rating?.value || null,
      comment: interest.comment || null,
      // keep the China date of the mark regardless of the runner timezone
      time: `${interest.create_time.slice(0, 10)}T12:00:00.000Z`,
      status,
      category,
    });
  }
  return feeds;
}

/**
 * Splits items into fixed-size chunks so Notion query filters stay small.
 *
 * @param {T[]} items - the items to split
 * @param {number} size - the maximum chunk size
 * @return {T[][]} the chunks
 */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function main(): Promise<void> {
  const user = process.env.DOUBAN_USER_ID;
  if (!user) {
    throw new Error('DOUBAN_USER_ID is required');
  }

  const dryRun = process.argv.includes('--dry-run');
  const targets: { type: string; category: ItemCategory }[] = [
    { type: 'movie', category: ItemCategory.Movie },
    { type: 'book', category: ItemCategory.Book },
  ];

  const feeds: FeedItem[] = [];
  for (const { type, category } of targets) {
    if (!getDataSourceId(category)) {
      consola.warn(`No notion database id for ${type}, skipping.`);
      continue;
    }
    const interests = [
      ...(await fetchInterests(user, type, 'done')),
      ...(await fetchInterests(user, type, 'doing')),
      ...(await fetchInterests(user, type, 'wish')),
    ];
    const categoryFeeds = toFeedItems(interests, category);
    consola.info(
      `${type}: ${categoryFeeds.length} unique marks`,
      `(${categoryFeeds.filter((feed) => feed.status === ItemStatus.Complete).length} done,`,
      `${categoryFeeds.filter((feed) => feed.status === ItemStatus.Progress).length} doing,`,
      `${categoryFeeds.filter((feed) => feed.status === ItemStatus.Wishlist).length} wishlist)`,
    );
    feeds.push(...categoryFeeds);
  }

  if (dryRun) {
    consola.info(`Dry run: ${feeds.length} feeds, nothing written to Notion.`);
    for (const feed of feeds.slice(0, 5)) {
      consola.log(feed);
    }
    return;
  }

  const chunks = chunk(feeds, CHUNK_SIZE);
  let failedChunks = 0;
  for (const [index, chunkFeeds] of chunks.entries()) {
    consola.start(`Backfilling chunk ${index + 1}/${chunks.length} (${chunkFeeds.length} items)...`);
    try {
      await handleNotion(chunkFeeds);
    } catch (error) {
      failedChunks += 1;
      consola.error(`Chunk ${index + 1}/${chunks.length} failed.`, error);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  if (failedChunks > 0) {
    throw new Error(`${failedChunks}/${chunks.length} backfill chunk(s) failed, rerun to retry.`);
  }
  consola.success(`Backfill completed: ${feeds.length} marks processed.`);
}

main().catch((error) => {
  consola.error(error);
  process.exit(1);
});
