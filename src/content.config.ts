import { defineCollection } from "astro:content";
import { file, glob } from "astro/loaders";
import { z } from "astro/zod";

const blog = defineCollection({
  // Recursively load every Markdown entry while keeping the public URL based on
  // the filename only. This lets folders organize source files without changing
  // existing routes such as /blog/uds/.
  loader: glob({
    base: "./src/content/blog",
    pattern: "**/*.{md,mdx}",
    generateId: ({ entry }) => {
      const filename = entry.replaceAll("\\", "/").split("/").pop() ?? entry;
      const id = filename.replace(/\.(md|mdx)$/i, "").toLowerCase();

      if (!/^[a-z0-9_-]+$/.test(id)) {
        throw new Error(
          `Blog filename must use only letters, numbers, hyphens, and underscores: ${entry}`,
        );
      }

      return id;
    },
  }),
  // Type-check frontmatter using a schema
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      // Category membership comes only from the first folder below
      // src/content/blog; the folder's _category.json controls its UI text.
      series: z
        .object({
          id: z.string().regex(/^[a-z0-9_-]+$/),
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

const blogCategories = defineCollection({
  loader: glob({
    base: "./src/content/blog",
    pattern: "*/_category.json",
    generateId: ({ entry }) => entry.replaceAll("\\", "/").split("/")[0],
  }),
  schema: z.object({
    title: z.string().min(1),
    description: z.string().default(""),
    order: z.number().int().default(100),
    homeSection: z.boolean().default(false),
  }),
});

const series = defineCollection({
  loader: file("./src/content/series.json"),
  schema: z.object({
    id: z.string().regex(/^[a-z0-9_-]+$/),
    title: z.string().min(1),
    description: z.string().default(""),
    order: z.number().int().default(100),
  }),
});

export const collections = { blog, blogCategories, series };
