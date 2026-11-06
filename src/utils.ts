import dotenv from 'dotenv';
import DB_PROPERTIES from '../cols.json';
import {
  ItemCategory,
  NotionPropTypesEnum,
  type NotionRichTextPropType,
  type NotionTitlePropType,
  type NotionFilesPropType,
  type NotionDatePropType,
  type NotionMultiSelectPropType,
  type NotionSelectPropType,
  type NotionNumberPropType,
  type NotionUrlPropType,
  type NotionColPropTypes,
} from './types';

dotenv.config();

/**
 * Retrieves the data source ID for the given category.
 *
 * @param {ItemCategory} category - The category of the item.
 * @returns {string} The corresponding database ID.
 */
export function getDataSourceId(category: ItemCategory): string {
  const databasesMap = {
    [ItemCategory.Movie]: process.env.NOTION_MOVIE_DATABASE_ID,
    [ItemCategory.Music]: process.env.NOTION_MUSIC_DATABASE_ID,
    [ItemCategory.Book]: process.env.NOTION_BOOK_DATABASE_ID,
    [ItemCategory.Game]: process.env.NOTION_GAME_DATABASE_ID,
    [ItemCategory.Drama]: process.env.NOTION_DRAMA_DATABASE_ID,
  };
  return databasesMap[category] as string;
}

/**
 * Delays the execution of a function by a specified number of milliseconds.
 *
 * @param {number} ms - The number of milliseconds to sleep
 * @return {Promise<void>} A Promise that resolves after the specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const RICH_TEXT_CONTENT_LIMIT = 2000;
const RICH_TEXT_ITEM_LIMIT = 100;

/**
 * Splits a value into Notion rich text items. Each item is capped at the API
 * limit of 2000 characters per text object.
 *
 * @param {unknown} value - the value to split
 * @return {NotionRichTextPropType['rich_text']} the rich text items
 */
function splitRichText(value: unknown): NotionRichTextPropType['rich_text'] {
  const content = typeof value === 'string' ? value : String(value ?? '');
  const chunks = content.match(new RegExp(`[\\s\\S]{1,${RICH_TEXT_CONTENT_LIMIT}}`, 'g')) ?? [''];
  return chunks.slice(0, RICH_TEXT_ITEM_LIMIT).map((chunk) => ({
    type: 'text' as const,
    text: {
      content: chunk,
    },
  }));
}

/**
 * Generates the value for a property based on the given parameters, ready to insert
 * into notion database.
 *
 * @param {any} value - the value to be processed
 * @param {NotionPropTypesEnum} type - the type of the Notion database property
 * @param {string} key - the key associated with the property
 * @return {any} the generated value for the property later will be sent to notion to create an item
 */
export function buildPropertyValue(value: any, type: NotionPropTypesEnum, key: string): NotionColPropTypes | undefined {
  switch (type) {
    case NotionPropTypesEnum.TITLE:
      return {
        type: NotionPropTypesEnum.TITLE,
        title: [
          {
            text: {
              content: value,
            },
          },
        ],
      } as NotionTitlePropType;
    case NotionPropTypesEnum.FILES:
      return {
        type: NotionPropTypesEnum.FILES,
        files: [
          {
            name: value,
            type: 'external',
            external: {
              url: value
            },
          },
        ],
      } as NotionFilesPropType;
    case NotionPropTypesEnum.DATE:
      return {
        type: NotionPropTypesEnum.DATE,
        date: {
          start: value,
        },
      } as NotionDatePropType;
    case NotionPropTypesEnum.SELECT:
      return {
        type: NotionPropTypesEnum.SELECT,
        select: value ? { name: value } : null,
      } as NotionSelectPropType;
    case NotionPropTypesEnum.MULTI_SELECT:
      return key === DB_PROPERTIES.RATING
        ? {
          type: NotionPropTypesEnum.MULTI_SELECT,
          multi_select: value
            ? [{ name: value.toString() }]
            : [],
        } as NotionMultiSelectPropType
        : {
          type: NotionPropTypesEnum.MULTI_SELECT,
          multi_select: (value || []).map((g: string) => ({ name: g })),
        } as NotionMultiSelectPropType;
    case NotionPropTypesEnum.RICH_TEXT:
      return {
        type: NotionPropTypesEnum.RICH_TEXT,
        rich_text: splitRichText(value),
      } as NotionRichTextPropType;
    case NotionPropTypesEnum.NUMBER:
      return {
        type: NotionPropTypesEnum.NUMBER,
        number: value ? Number(value) : null,
      } as NotionNumberPropType;
    case NotionPropTypesEnum.URL:
      return {
        type: NotionPropTypesEnum.URL,
        url: value,
      } as NotionUrlPropType;
    default:
      break;
  }
}
