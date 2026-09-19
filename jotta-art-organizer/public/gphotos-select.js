// Runs inside photos.google.com, started from a bookmark or pasted into the
// browser console. Ticks the photos whose capture time matches a list made by
// Jotta Art Organizer from a Takeout export that was checked to have fully
// arrived in Jottacloud — and then stops. It never deletes: reviewing the
// selection and pressing the bin stays with the person.
//
// Matching is by capture time to the second, in the time zone where each
// photo was taken — which is how Google labels them. Where several photos
// share a second, they're ticked only if the page shows no more of them than
// the export holds; otherwise that second is reported for checking by eye.
//
// Built with createElement throughout: Google's pages enforce Trusted Types,
// under which assigning innerHTML throws.
(() => {
  if (window.__jaoSelector) {
    window.__jaoSelector.panel.style.display = 'block'
    return
  }

  const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 }
  // "Photo - Portrait - Sep 1, 2026, 12:58:53 PM" → "20260901T125853".
  // \s also covers the narrow no-break space some browsers put before AM/PM.
  const LABEL = /^(Photo|Video) - .*? - ([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/

  function keyOf(label) {
    const m = LABEL.exec(label || '')
    if (!m) return null
    const month = MONTHS[m[2]]
    if (!month) return null
    let hour = Number(m[5]) % 12
    if (m[8] === 'PM') hour += 12
    const p = (n) => String(n).padStart(2, '0')
    return `${m[4]}${p(month)}${p(Number(m[3]))}T${p(hour)}${m[6]}${m[7]}`
  }

  function readable(key) {
    return `${key.slice(6, 8)}/${key.slice(4, 6)}/${key.slice(0, 4)} ${key.slice(9, 11)}:${key.slice(11, 13)}:${key.slice(13, 15)}`
  }

  const tiles = () =>
    [...document.querySelectorAll('[role=checkbox][aria-label]')].filter((c) =>
      /^(Photo|Video) - /.test(c.getAttribute('aria-label'))
    )

  function scroller() {
    let el = tiles()[0]
    while (el) {
      const s = getComputedStyle(el)
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 10) return el
      el = el.parentElement
    }
    return document.scrollingElement
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // ---- panel ---------------------------------------------------------------
  function el(tag, props, children) {
    const node = document.createElement(tag)
    Object.assign(node, props || {})
    for (const c of children || []) node.append(c)
    return node
  }

  const status = el('div', { textContent: 'Paste the list copied from Jotta Art Organizer, then press Start.' })
  status.style.cssText = 'margin:8px 0;white-space:pre-wrap;'
  const input = el('textarea', { placeholder: 'Paste the list here' })
  input.style.cssText = 'width:100%;height:70px;font:12px monospace;box-sizing:border-box;color:#000;background:#fff;'
  const start = el('button', { textContent: 'Start' })
  const stop = el('button', { textContent: 'Stop', disabled: true })
  const close = el('button', { textContent: 'Close' })
  for (const b of [start, stop, close]) b.style.cssText = 'margin-right:6px;padding:4px 10px;cursor:pointer;'
  const report = el('div')
  report.style.cssText = 'max-height:180px;overflow:auto;font-size:12px;margin-top:6px;'

  const panel = el('div', {}, [
    el('div', { textContent: 'Select archived photos' }),
    status,
    input,
    el('div', {}, [start, stop, close]),
    report,
  ])
  panel.firstChild.style.cssText = 'font-weight:600;font-size:14px;'
  panel.style.cssText =
    'position:fixed;top:72px;right:16px;z-index:2147483647;width:340px;padding:12px;border-radius:8px;' +
    'background:#fff;color:#111;font:13px system-ui,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.35);'
  document.body.append(panel)
  window.__jaoSelector = { panel }

  let stopped = false
  stop.onclick = () => {
    stopped = true
    status.textContent = 'Stopping…'
  }
  close.onclick = () => {
    stopped = true
    panel.style.display = 'none'
  }

  start.onclick = async () => {
    let list
    try {
      list = JSON.parse(input.value)
      if (list.v !== 1 || !Array.isArray(list.keys)) throw new Error('not a list')
    } catch {
      status.textContent = 'That doesn’t look like the list from Jotta Art Organizer. Copy it again and paste it here.'
      return
    }
    const expected = new Map()
    for (const k of list.keys) expected.set(k, (expected.get(k) || 0) + 1)

    if (tiles().length === 0) {
      status.textContent = 'No photos found on this page. Open your Photos timeline, then press Start again.'
      return
    }
    if (tiles().every((t) => !keyOf(t.getAttribute('aria-label')))) {
      // Most likely the account's language isn't English, so the dates read
      // differently. Better to stop here than tick on a misreading.
      status.textContent =
        'Couldn’t read the dates on this page, so nothing was ticked. The Google account’s language may need to be English for this.'
      return
    }

    stopped = false
    start.disabled = true
    stop.disabled = false
    input.disabled = true
    report.replaceChildren()

    const box = scroller()
    box.scrollTop = 0
    await sleep(1200)

    const decided = new Set()
    const flagged = []
    let ticked = 0
    let notInExport = 0
    // By label, not by pass: the same unreadable tile is seen on several steps.
    const unreadable = new Set()
    let stuck = 0

    const settle = (group, key) => {
      decided.add(key)
      const want = expected.get(key) || 0
      if (want === 0) {
        notInExport += group.length
        return []
      }
      if (group.length > want) {
        flagged.push(`${readable(key)} — ${group.length} photos here, ${want} in the export`)
        return []
      }
      return group
    }

    for (;;) {
      const atTop = box.scrollTop <= 0
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4

      const byKey = new Map()
      for (const t of tiles()) {
        const key = keyOf(t.getAttribute('aria-label'))
        if (!key) {
          unreadable.add(t.getAttribute('aria-label'))
          continue
        }
        if (!byKey.has(key)) byKey.set(key, [])
        byKey.get(key).push(t)
      }
      const keys = [...byKey.keys()].sort()
      const oldest = keys[0]
      const newest = keys[keys.length - 1]

      const toTick = []
      for (const [key, group] of byKey) {
        if (decided.has(key)) continue
        // A second at the edge of what's loaded may have more photos just out
        // of view, so its count can't be trusted yet — it'll be in the middle
        // after the next step. The very top and bottom have nothing beyond.
        if (key === newest && !atTop) continue
        if (key === oldest && !atBottom) continue
        toTick.push(...settle(group, key))
      }

      for (const t of toTick) {
        if (stopped) break
        if (t.getAttribute('aria-checked') !== 'true') {
          t.click()
          ticked++
          await sleep(25)
        }
      }

      status.textContent =
        `Ticked ${ticked.toLocaleString()} so far · reached ${oldest ? readable(oldest).slice(0, 10) : '…'}`
      if (stopped || atBottom) break

      const before = box.scrollTop
      box.scrollTop += Math.round(box.clientHeight * 0.6)
      await sleep(900)
      if (box.scrollTop === before) {
        if (++stuck >= 3) break
      } else {
        stuck = 0
      }
    }

    start.disabled = false
    stop.disabled = true
    input.disabled = false

    const selectedNow = (document.body.innerText.match(/([\d,.]+)\s+selected/) || [])[1]
    status.textContent =
      `${stopped ? 'Stopped' : 'Done'}. Ticked ${ticked.toLocaleString()} photos` +
      (selectedNow ? ` (Google shows ${selectedNow} selected).` : '.') +
      `\n${notInExport.toLocaleString()} on this page aren’t in the export and were left alone.` +
      (unreadable.size ? `\n${unreadable.size} couldn’t be read and were left alone.` : '') +
      (flagged.length ? `\n${flagged.length} moments need checking by eye — listed below; none of them were ticked.` : '') +
      '\n\nNothing has been deleted. Look over the selection, then use Google’s bin button if you’re happy.'

    if (flagged.length) {
      report.replaceChildren(...flagged.map((f) => el('div', { textContent: f })))
    }
  }
})()
