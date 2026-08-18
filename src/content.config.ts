import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Recursively load every Markdown entry while keeping the public URL based on
	// the filename only. This lets folders organize source files without changing
	// existing routes such as /blog/uds/.
	loader: glob({
		base: './src/content/blog',
		pattern: '**/*.{md,mdx}',
		generateId: ({ entry }) => {
			const filename = entry.replaceAll('\\', '/').split('/').pop() ?? entry;
			const id = filename.replace(/\.(md|mdx)$/i, '').toLowerCase();

			if (!/^[a-z0-9_-]+$/.test(id)) {
				throw new Error(`Blog filename must use only letters, numbers, hyphens, and underscores: ${entry}`);
			}

			return id;
		},
	}),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			category: z.enum(['驱动', '协议', '操作系统', '架构', '方法', '项目']),
			series: z
				.object({
					id: z.enum([
						'vehicle-ethernet',
						'camera-development',
						'linux-camera',
						'uds-diagnostics',
						'demosaic',
					]),
					order: z.number().int().positive(),
				})
				.optional(),
			tags: z.array(z.string()).min(1),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
		}),
});

export const collections = { blog };
