import { getCollection, type CollectionEntry } from 'astro:content';
import { getBlogCategories } from './blog';

export type BlogPost = CollectionEntry<'blog'>;

export type SeriesDefinition = {
	id: string;
	title: string;
	description: string;
	category: string;
	order: number;
};

export async function getSeriesDefinitions(posts: BlogPost[] = []) {
	const entries = await getCollection('series');
	const definitions = new Map<string, SeriesDefinition>(
		entries.map((entry) => [
			entry.id,
			{
				id: entry.id,
				...entry.data,
			},
		]),
	);

	for (const post of posts) {
		const id = post.data.series?.id;
		if (id && !definitions.has(id)) {
			throw new Error(
				`Missing series config for "${id}". Add an entry with that id to src/content/series.json.`,
			);
		}
	}

	const categoryIds = new Set((await getBlogCategories(posts)).map((category) => category.id));
	for (const definition of definitions.values()) {
		if (!categoryIds.has(definition.category)) {
			throw new Error(
				`Series "${definition.id}" references unknown category "${definition.category}". Add that category config or update its entry in src/content/series.json.`,
			);
		}
	}

	return [...definitions.values()].sort(
		(a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh-CN'),
	);
}

export function getSeriesDefinition(
	definitions: SeriesDefinition[],
	id: string | undefined,
) {
	return definitions.find((series) => series.id === id);
}

export function getSeriesPosts(posts: BlogPost[], seriesId: string) {
	const seriesPosts = posts
		.filter((post) => post.data.series?.id === seriesId)
		.sort((a, b) => (a.data.series?.order ?? 0) - (b.data.series?.order ?? 0));

	const seenOrders = new Set<number>();
	for (const post of seriesPosts) {
		const order = post.data.series?.order;
		if (order === undefined) continue;
		if (seenOrders.has(order)) {
			throw new Error(`Duplicate order ${order} in blog series "${seriesId}".`);
		}
		seenOrders.add(order);
	}

	return seriesPosts;
}

export function getSeriesReaderPath(seriesId: string, postId: string, firstPostId?: string) {
	return postId === firstPostId ? `/series/${seriesId}/` : `/series/${seriesId}/${postId}/`;
}

export function getSeriesChapterTitle(post: BlogPost) {
	const [prefix, ...rest] = post.data.title.split(/[：:]/);
	return rest.length > 0 && /[（(][一二三四五六七八九十0-9]+[)）]/.test(prefix)
		? rest.join('：').trim()
		: post.data.title;
}

export function getSeriesContext(
	posts: BlogPost[],
	currentId: string | undefined,
	definitions: SeriesDefinition[],
) {
	if (!currentId) return undefined;
	const current = posts.find((post) => post.id === currentId);
	const seriesId = current?.data.series?.id;
	if (!current || !seriesId) return undefined;

	const definition = getSeriesDefinition(definitions, seriesId);
	if (!definition) return undefined;
	const seriesPosts = getSeriesPosts(posts, seriesId);
	const index = seriesPosts.findIndex((post) => post.id === currentId);
	if (index < 0) return undefined;

	return {
		definition,
		posts: seriesPosts,
		position: index + 1,
		previous: index > 0 ? seriesPosts[index - 1] : undefined,
		next: index < seriesPosts.length - 1 ? seriesPosts[index + 1] : undefined,
	};
}
