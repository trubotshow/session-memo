import type { EngineInterface, Register } from 'claude-code'

const PANE = 'memo'
const TITLE = 'Memo'
// A drawing carries each small picture as text: the newest are drawn until this many characters are used.
const THUMB_BUDGET = 150000
const ZW = '​'
// How many Enters a field can take before it is replaced by a fresh one (see `entered`).
const STOCK = 100

/** What was written, in order: stretches of text and the screenshots put between them. */
type TextBlock = { kind: 'text'; id: string; text: string }
type ShotBlock = { kind: 'shot'; id: string; png: string; thumb: string; big: string; w: number; h: number; bw: number; bh: number }
type Block = TextBlock | ShotBlock
/** One session's memo. With no screenshot it is one stretch of text: one box that is the whole notepad. */
type Memo = { sid: string; blocks: Block[] }

// This run's copy of the session's memo: every change is made here first, then written to the mod's store
// (key `pad:<session id>`), so it outlives a restart. Nothing here calls the model.
let memo: Memo | undefined
// What each text field holds, its invisible stock included (see `entered`), and how often it was replaced.
const raws = new Map<string, string>()
const gens = new Map<string, number>()
let bigShot: string | undefined
let columns = 60
// Picture files already read in this run: file → base64 (undefined = it could not be read).
const pics = new Map<string, string | undefined>()

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const strip = (text: string) => text.replaceAll(ZW, '')
const stocked = (text: string) => ZW.repeat(STOCK) + text
const join = (a: string, b: string) => (a === '' || b === '' || a.endsWith('\n') ? a + b : a + '\n' + b)

const isBlock = (v: unknown): v is Block => {
  const b = v as Partial<TextBlock & ShotBlock> | null
  if (typeof b !== 'object' || b === null || typeof b.id !== 'string') return false
  if (b.kind === 'text') return typeof b.text === 'string'

  return b.kind === 'shot' && [b.png, b.thumb, b.big].every(p => typeof p === 'string') && [b.w, b.h, b.bw, b.bh].every(n => typeof n === 'number')
}

// Text next to text is one stretch, an emptied stretch is gone, and the memo always ends in text to write in.
const tidy = (blocks: Block[]) => {
  const out: Block[] = []
  for (const b of blocks) {
    const last = out.at(-1)
    if (b.kind === 'text' && last?.kind === 'text') out[out.length - 1] = { ...last, text: join(last.text, b.text) }
    else out.push(b)
  }
  const kept = out.filter((b, i) => b.kind !== 'text' || b.text.trim() !== '' || i === out.length - 1)
  if (kept.at(-1)?.kind !== 'text') kept.push({ kind: 'text', id: newId(), text: '' })

  return kept
}

// Every session shares one memo under `pad:shared`. It is read from the store each time, so what another
// session wrote shows up here on the next redraw.
const SHARED = 'shared'

const padOf = async ($: EngineInterface): Promise<Memo> => {
  const sid = await $.session.id()
  let shared = await $.store.get('pad:' + SHARED)
  if (shared === undefined) {
    // First open after the switch: gather every session's old memo into the shared one, skipping repeats.
    const blocks: Block[] = []
    const seen = new Set<string>()
    for (const k of await $.store.keys()) {
      const old = k.startsWith('pad:') ? ((await $.store.get(k)) as { blocks?: unknown }) : undefined
      for (const b of Array.isArray(old?.blocks) ? old.blocks.filter(isBlock) : []) {
        const id = b.kind === 'text' ? b.text.trim() : b.png
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        blocks.push(b.kind === 'text' ? { ...b, text: b.text.trimEnd() + '\n\n' } : b)
      }
    }
    if (blocks.length) {
      shared = { blocks: tidy(blocks) }
      await $.store.set('pad:' + SHARED, shared)
    }
  }
  const kept = (shared ?? (await $.store.get('pad:' + sid))) as { blocks?: unknown; tail?: unknown } | undefined
  const blocks: Block[] = Array.isArray(kept?.blocks) ? kept.blocks.filter(isBlock) : []
  // An earlier version kept the line being typed apart.
  if (typeof kept?.tail === 'string' && kept.tail !== '') blocks.push({ kind: 'text', id: newId(), text: kept.tail })
  if (kept === undefined) {
    // What the first versions kept: one text under `memo:`, a list of screenshots under `shots:`.
    const text = await $.store.get('memo:' + sid)
    const shots = await $.store.get('shots:' + sid)
    if (typeof text === 'string') blocks.push({ kind: 'text', id: newId(), text })
    for (const s of Array.isArray(shots) ? (shots as Record<string, unknown>[]) : []) {
      if (typeof s?.id === 'string' && typeof s.png === 'string' && typeof s.jpg === 'string' && typeof s.w === 'number' && typeof s.h === 'number') {
        blocks.push({ kind: 'shot', id: s.id, png: s.png, thumb: s.jpg, big: s.jpg, w: s.w, h: s.h, bw: s.w, bh: s.h })
      }
    }
  }
  memo = { sid: SHARED, blocks: tidy(blocks) }

  return memo
}

// What this session last wrote or saw in the shared memo, and when it last wrote: the sync below skips both.
let lastSeen = 'null'
let lastLocal = 0

const keep = async ($: EngineInterface, m: Memo) => {
  // An emptied memo leaves nothing behind in the store.
  const isEmpty = m.blocks.every(b => b.kind === 'text' && b.text.trim() === '')
  const value = isEmpty ? undefined : { blocks: m.blocks }
  lastLocal = Date.now()
  lastSeen = JSON.stringify(value ?? null)
  if (value === undefined) await $.store.delete('pad:' + m.sid)
  else await $.store.set('pad:' + m.sid, value)
}

// Live sync: every second, when this session is not mid-typing, redraw if another session changed the memo.
const sync = async ($: EngineInterface) => {
  if (Date.now() - lastLocal < 1500) return
  const now = JSON.stringify((await $.store.get('pad:' + SHARED)) ?? null)
  if (now === lastSeen) return
  lastSeen = now
  // Fresh fields, so the new text is drawn even in a box that still holds the old one.
  for (const b of (await padOf($)).blocks) if (b.kind === 'text') gens.set(b.id, (gens.get(b.id) ?? 0) + 1)
  $.ui.invalidate('ui.render')
}

const setText = (m: Memo, id: string, text: string) => {
  m.blocks = m.blocks.map(b => (b.kind === 'text' && b.id === id ? { ...b, text } : b))
}

// What a text field is drawn with: what it was last known to hold, or the text behind a fresh stock.
const rawOf = (b: TextBlock) => {
  const held = raws.get(b.id)
  if (held !== undefined && strip(held) === b.text) return held
  const fresh = stocked(b.text)
  raws.set(b.id, fresh)

  return fresh
}

// Every field gets a full stock again: called where a button was pressed, so no field has the cursor.
const restock = (m: Memo) => {
  for (const b of m.blocks) if (b.kind === 'text') raws.set(b.id, stocked(b.text))
}

const typed = async ($: EngineInterface, id: string, value: string) => {
  const m = await padOf($)
  raws.set(id, value)
  setText(m, id, strip(value))
  await keep($, m)
}

// Enter. The desktop hands it over as a submit, never as a new line, and after a redraw it puts the cursor back at
// the index it had. So a new line is added at the end and, for the cursor (at the end, index n) to stand after it,
// the text before it must get one character shorter: each field starts with a stock of zero-width spaces, and each
// Enter takes one away. A field whose stock ran out is replaced by a fresh one (one click to go on typing).
const entered = async ($: EngineInterface, id: string, value: string) => {
  // Plain Enter now only keeps what is there: the field never says where the cursor is, so a line added at the
  // end only piled up blank lines. Shift+Enter puts a new line at the cursor.
  return typed($, id, value)
  const m = await padOf($)
  const at = value.indexOf(ZW)
  if (at >= 0) raws.set(id, value.slice(0, at) + value.slice(at + 1) + '\n')
  else {
    gens.set(id, (gens.get(id) ?? 0) + 1)
    raws.set(id, stocked(strip(value) + '\n'))
  }
  setText(m, id, strip(value) + '\n')
  await keep($, m)
  $.ui.invalidate('ui.render')
}

// How many rows a stretch of text needs, long lines folded at the pane's width (Korean letters are two cells wide).
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
const linesOf = (text: string) => {
  const room = Math.max(16, columns - 6)
  let rows = 0
  for (const line of text.split('\n')) {
    let cells = 0
    for (const ch of line) cells += WIDE.test(ch) ? 2 : 1
    rows += Math.max(1, Math.ceil(cells / room))
  }

  return rows
}

const picOf = async ($: EngineInterface, file: string) => {
  if (!pics.has(file)) {
    try {
      const { base64 } = await $.fs.read(file, { as: 'bytes' })
      pics.set(file, base64)
    } catch {
      pics.set(file, undefined)
    }
  }

  return pics.get(file)
}

const svgOf = (w: number, h: number, base64: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" href="data:image/jpeg;base64,${base64}"/></svg>`

const sizeOf = async ($: EngineInterface, file: string) => {
  const out = (await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file])).stdout

  return [Number(/pixelWidth: (\d+)/.exec(out)?.[1]), Number(/pixelHeight: (\d+)/.exec(out)?.[1])] as const
}

// A note starts with one of these in the chat box: it goes into the memo and is not sent to Claude.
const MARK = /^\s*(?:ㅁ(?=\s|$)|메모\s*[:：]|memo\s*[:：])\s*/i
const PERSON = ['composer', 'sdk', 'bridge', 'unclassified']

// One picture attached to the prompt being submitted, whole: the engine hands it over in slices.
const mediaOf = async ($: EngineInterface, id: string) => {
  let base64 = ''
  let offset: number | undefined
  for (let n = 0; n < 16; n++) {
    const part = await $.prompt.media(offset === undefined ? { id } : { id, offset })
    if (part.base64 === undefined) return undefined
    base64 += part.base64
    if (part.next === undefined) return { base64, ext: /^image\/(png|gif|webp)$/.exec(part.mediaType)?.[1] ?? 'jpg' }
    offset = part.next
  }

  return undefined
}

// The picture becomes files beside this session's memo: the picture itself, a thumbnail, and a larger copy to
// look at. Resolves the screenshot, or undefined when it could not be made.
// shortcut: macOS only (base64 writes the file, sips makes the copies); another system needs its own commands.
const shotOf = async ($: EngineInterface, sid: string, media: { base64: string; ext: string }): Promise<ShotBlock | undefined> => {
  const home = await $.env.get('HOME')
  if (!home) return undefined
  const dir = `${home}/.claude/session-memo/${sid}`
  const id = newId()
  const png = `${dir}/${id}.${media.ext}`
  const thumb = `${dir}/${id}-s.jpg`
  const big = `${dir}/${id}-l.jpg`

  await $.process.run(['mkdir', '-p', dir])
  if ((await $.process.run(['base64', '-D', '-o', png], { stdin: media.base64 })).exitCode !== 0) return undefined
  const shrink = (max: string, quality: string, to: string) => $.process.run(['sips', '-Z', max, '-s', 'format', 'jpeg', '-s', 'formatOptions', quality, png, '--out', to])
  await shrink('320', '50', thumb)
  await shrink('800', '45', big)
  // One picture travels as text of at most 131072 characters: a busy one is made smaller once more.
  if ((await $.fs.stat(big)).size > 95000) await shrink('560', '35', big)
  const [w, h] = await sizeOf($, thumb)
  const [bw, bh] = await sizeOf($, big)
  if (!w || !h || !bw || !bh) return undefined

  return { kind: 'shot', id, png, thumb, big, w, h, bw, bh }
}

// Takes one screenshot out of the memo and removes the files the mod made for it.
const dropShot = async ($: EngineInterface, id: string) => {
  const m = await padOf($)
  const gone = m.blocks.find((b): b is ShotBlock => b.kind === 'shot' && b.id === id)
  m.blocks = tidy(m.blocks.filter(b => b.id !== id))
  if (bigShot === id) bigShot = undefined
  restock(m)
  await keep($, m)
  $.ui.invalidate('ui.render')
  if (gone) {
    pics.delete(gone.thumb)
    pics.delete(gone.big)
    try {
      await $.process.run(['rm', '-f', gone.png, gone.thumb, gone.big])
    } catch {
      // The memo no longer lists it; a file left behind is harmless.
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'memo',
      description: 'Open the memo shared by every session',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    lastSeen = JSON.stringify((await $.store.get('pad:' + SHARED)) ?? null)
    $.clock.every(1000, () => void sync($))

    return next(e)
  })

  // A small button above the prompt, so the memo opens with a click instead of typing /memo.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box>
        <Button
          key="open-memo"
          label="  📝  "
          variant="primary"
          onPress={async () => {
            // Same button opens and closes the memo.
            if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
            else await $.ui.open({ id: PANE, title: TITLE, focus: true })
          }}
        />
      </Box>
    )
  })

  on('command.run', { command: 'memo' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Opened the memo.' }
  })

  // A message that starts with ㅁ (or 메모: / memo:) is a note: its words go under what is written, its pasted
  // screenshots under them, and it never reaches the model. The memo box itself cannot take a paste.
  on('prompt.submit', async ($, e, next) => {
    const mark = MARK.exec(e.text)
    if (!mark || e.command || e.isMeta || !PERSON.includes(e.origin.kind)) return next(e)
    const m = await padOf($)
    const line = e.text.slice(mark[0].length).trimEnd()
    const shots: ShotBlock[] = []
    let missed = 0
    for (const item of e.attachments ?? []) {
      if (item.type !== 'image') continue
      try {
        const media = item.id ? await mediaOf($, item.id) : undefined
        const shot = media && (await shotOf($, m.sid, media))
        if (shot) shots.push(shot)
        else missed++
      } catch {
        missed++
      }
    }
    if (!line && !shots.length) return { drop: missed ? 'Could not read the screenshot for the memo.' : 'Nothing to add to the memo.' }

    const last = m.blocks.at(-1)
    const above = last?.kind === 'text' ? [...m.blocks.slice(0, -1), { ...last, text: join(last.text, line) }] : [...m.blocks, { kind: 'text', id: newId(), text: line } as const]
    m.blocks = tidy([...above, ...shots])
    restock(m)
    await keep($, m)
    $.ui.invalidate('ui.render')
    void $.ui.open({ id: PANE, title: TITLE })

    return { drop: `Added to the memo${shots.length ? ` (${shots.length} screenshot${shots.length > 1 ? 's' : ''})` : ''}${missed ? `, ${missed} could not be read` : ''}. Not sent to Claude.` }
    // Should the hook fail: a note is still not sent to the model, and any other message goes on as typed.
  }).catch(($, e, next) => (next.called || !MARK.test(e.text) ? next(e) : { drop: 'Could not add to the memo.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Input, Button } = table
    // The terminal draws no picture: there a screenshot is its file's path.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const m = await padOf($)
    columns = e.props.bodyColumns
    const room = e.props.scroll.bodyRows
    const isOneBox = m.blocks.length === 1

    // Which pictures are drawn: the enlarged one, and thumbnails newest first while the budget lasts.
    const drawn = new Map<string, string>()
    let used = 0
    for (const b of [...m.blocks].reverse()) {
      if (b.kind !== 'shot' || !Svg) continue
      const isBig = bigShot === b.id
      const base64 = await picOf($, isBig ? b.big : b.thumb)
      if (!base64 || (!isBig && used + base64.length > THUMB_BUDGET)) continue
      if (!isBig) used += base64.length
      drawn.set(b.id, base64)
    }

    // One box fills the pane; with screenshots each stretch of text is as tall as what it holds.
    const rowsFor = (b: TextBlock, isLast: boolean) => (isOneBox ? Math.max(4, Math.min(60, room - 2)) : Math.max(isLast ? 3 : 2, Math.min(40, linesOf(b.text) + 1)))

    // A thumbnail stands about five lines tall; a very wide one is held to the pane instead.
    const thumbWidth = (b: ShotBlock) => Math.max(24, Math.min(360, Math.round((110 * b.w) / b.h)))

    const shotView = (b: ShotBlock) => {
      const isBig = bigShot === b.id
      const base64 = drawn.get(b.id)

      return (
        <Box key={`s-${b.id}`} flexDirection="column" marginY="xs">
          <Box position="relative" alignSelf="flex-start">
            {Svg && base64 ? (
              isBig ? <Svg source={svgOf(b.bw, b.bh, base64)} alt="Screenshot" /> : <Svg source={svgOf(b.w, b.h, base64)} alt="Screenshot" width={thumbWidth(b)} />
            ) : (
              <Text dimColor>[Screenshot] {b.png}</Text>
            )}
            <Box position="absolute" top={0} right={0} flexDirection="row">
              {Svg && base64 && (
                <Button
                  key={`zoom-${b.id}`}
                  onPress={() => {
                    bigShot = isBig ? undefined : b.id
                    restock(m)
                    $.ui.invalidate('ui.render')
                  }}
                >
                  {isBig ? 'Smaller' : 'Larger'}
                </Button>
              )}
              <Button key={`drop-${b.id}`} onPress={() => void dropShot($, b.id)}>
                ✕
              </Button>
            </Box>
          </Box>
          {isBig && (
            <Button
              key={`path-${b.id}`}
              plain
              dimColor
              onPress={press => {
                void $.ui.copy({ text: b.png, surface: press.surface })
                $.ui.toast('Copied the file path. Paste it into the chat for Claude to see it')
              }}
            >
              Copy path
            </Button>
          )}
        </Box>
      )
    }

    // A field is drawn with what it holds now. Typing saves and asks for no redraw, so nothing is drawn over
    // while a person types. No field has a submitLabel: the desktop draws a button beside one that has.
    return (
      <Box flexDirection="column" marginTop="sm">
        {m.blocks.map((b, i) =>
          b.kind === 'text' ? (
            <Input
              key={`t-${b.id}-${gens.get(b.id) ?? 0}`}
              rows={rowsFor(b, i === m.blocks.length - 1)}
              value={rawOf(b)}
              onInput={text => void typed($, b.id, text)}
              onSubmit={text => void entered($, b.id, text)}
            />
          ) : (
            shotView(b)
          ),
        )}
      </Box>
    )
  })
}
