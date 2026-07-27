import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Jotta Art Organizer',
    short_name: 'Art Organizer',
    description: 'Import finished Picsart artwork and organize it into Jottacloud folders.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b1220',
    theme_color: '#4f46e5',
    icons: [
      {
        src: '/icon',
        sizes: '192x192',
        type: 'image/png',
      },
    ],
  }
}
