import { redirect } from 'next/navigation'

// The page was renamed Copy — it moves and copies files, and calling that a
// backup promised something it doesn't do. The old path stays as a redirect
// because it may be bookmarked, or pinned to a home screen, where a 404
// would look like the app had broken.
export default function BackupRedirect() {
  redirect('/copy')
}
