// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://reynor-0.github.io',
	integrations: [mdx(), sitemap()],
	redirects: {
		'/projects': '/blog',
		'/projects/v4l2-camera-pipeline': '/blog/v4l2-camera-pipeline',
		'/projects/personal-blog-system': '/blog/personal-blog-system',
		'/projects/demosaic-algorithm-notes': '/blog/demosaic-algorithm-notes',
		'/reading': '/blog',
		'/reading/v4l2-buffer-management': '/blog/v4l2-buffer-management',
		'/reading/csapp': '/blog/csapp',
		'/reading/backpressure-streaming': '/blog/backpressure-streaming',
		'/reading/ahd-demosaicing': '/blog/ahd-demosaicing',
		'/notes': '/blog',
		'/notes/realtime-vs-integrity': '/blog/realtime-vs-integrity',
		'/notes/keep-the-problem-context': '/blog/keep-the-problem-context',
		'/notes/blog-as-knowledge-base': '/blog/blog-as-knowledge-base',
	},
	vite: {
		ssr: {
			external: ['picomatch', 'piccolore'],
		},
	},
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'Atkinson',
			cssVariable: '--font-atkinson',
			fallbacks: ['sans-serif'],
			options: {
				variants: [
					{
						src: ['./src/assets/fonts/atkinson-regular.woff'],
						weight: 400,
						style: 'normal',
						display: 'swap',
					},
					{
						src: ['./src/assets/fonts/atkinson-bold.woff'],
						weight: 700,
						style: 'normal',
						display: 'swap',
					},
				],
			},
		},
	],
});
