import { redirect } from 'next/navigation'

// Renamed to Catalogue: the section is where work is described and found
// again, which is what a catalogue is — "tags" named the mechanism instead.
// The old path stays as a redirect for bookmarks and home-screen shortcuts.
export default function TagsRedirect() {
  redirect('/catalogue')
}
