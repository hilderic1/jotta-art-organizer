import { redirect } from 'next/navigation'

// Tagging is what this app is opened for, so it opens there. Import, Dedupe
// and Copy stay a click away in the nav rather than behind a landing page
// that has to be clicked through every time. Account details and the archive
// browser moved to /setup, which is where connection management already was.
export default function Home() {
  redirect('/tags')
}
