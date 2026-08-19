import { getCollection, type CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;

export type BlogCategoryDefinition = {
	id: string;
	title: string;
	description: string;
	order: number;
	homeSection: boolean;
};

export function getPostCategoryId(post: BlogPost) {
	const pathParts = post.filePath?.replaceAll('\\', '/').split('/').filter(Boolean) ?? [];
	const blogIndex = pathParts.lastIndexOf('blog');
	return blogIndex >= 0 && pathParts[blogIndex + 1]
		? pathParts[blogIndex + 1].toLowerCase()
		: 'uncategorized';
}

export async function getBlogCategories(posts: BlogPost[] = []) {
	const entries = await getCollection('blogCategories');
	const definitions = new Map<string, BlogCategoryDefinition>(
		entries.map((entry) => [
			entry.id,
			{
				id: entry.id,
				...entry.data,
			},
		]),
	);

	for (const post of posts) {
		const id = getPostCategoryId(post);
		if (!definitions.has(id)) {
			throw new Error(
				`Missing category config for blog folder "${id}". Add src/content/blog/${id}/_category.json.`,
			);
		}
	}

	return [...definitions.values()].sort(
		(a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh-CN'),
	);
}

export function getCategoryDefinition(
	categories: BlogCategoryDefinition[],
	id: string | undefined,
) {
	return categories.find((category) => category.id === id);
}

export function getPostCategory(
	post: BlogPost,
	categories: BlogCategoryDefinition[],
) {
	const id = getPostCategoryId(post);
	const definition = getCategoryDefinition(categories, id);
	if (!definition) {
		throw new Error(
			`Missing category config for blog folder "${id}". Add src/content/blog/${id}/_category.json.`,
		);
	}
	return definition;
}

export function tagSlug(tag: string) {
	return encodeURIComponent(tag.trim()).replaceAll('%', '').toLowerCase();
}

export function estimateReadingMinutes(body: string | undefined) {
	const source = body ?? '';
	const chineseCharacters = source.match(/[\u3400-\u9fff]/g)?.length ?? 0;
	const latinWords = source.match(/[A-Za-z0-9_]+/g)?.length ?? 0;

	return Math.max(1, Math.ceil(chineseCharacters / 400 + latinWords / 220));
}
