import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'session-memo',
  component: 'Pane',
  requestId: 'memo',
  props: {
    title: 'Memo',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const ZW = '​'
type Kept = { blocks: { kind: string; id: string; text?: string; png?: string }[] }
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

// The hooks a test registers stand for the engine: the mod's store and the session's id.
// Each test names sessions of its own: the mod keeps a session's memo in memory once read.
function world(on: On, session: () => string) {
  const kept = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    kept.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    kept.delete(e.key)

    return { value: undefined }
  })
  on('session.id', () => ({ value: session() }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // A prompt that reaches here has entered the session.
  on('prompt.submit', (_, e) => ({ text: e.text }))

  return kept
}

// The text fields of a drawing, in order: each one's key and what it holds.
const fields = (tree: unknown): { key: string; value: string; rows: number }[] => {
  const node = tree as Node
  if (typeof node !== 'object' || node === null) return []
  const own = node.type === 'Input' ? [{ key: String(node.props?.key), value: String(node.props?.value ?? ''), rows: Number(node.props?.rows) }] : []

  return [...own, ...(node.children ?? []).flatMap(fields)]
}

const types = (tree: unknown): string[] => {
  const node = tree as Node
  if (typeof node !== 'object' || node === null) return []

  return [node.type ?? '', ...(node.children ?? []).flatMap(types)]
}

test('one box is the whole notepad: typing is kept, and Enter leaves the cursor after a new last line', async ($, on) => {
  let session = ''
  const kept = world(on, () => session)

  for (const surface of ['terminal', 'desktop'] as const) {
    session = 'a-' + surface
    const key = 'pad:shared'
    const ui = await $.ui.mount({ ...PANE, surface })
    // Nothing but the box: no button, no line of help.
    expect(types(await ui.drawn()).filter(t => t !== 'Box')).toEqual(['Input'])
    const [box] = fields(await ui.drawn())
    expect(box?.rows).toBe(18)

    // What the field holds starts with the invisible stock; what is kept has none of it.
    const typed = box?.value + 'cut intro 12'
    await ui.input({ key: box?.key ?? '', text: typed, kind: 'change' })
    expect((kept.get(key) as Kept).blocks.map(b => b.text)).toEqual(['cut intro 12'])

    // Enter: a new line at the end. The field is drawn exactly as long as it was, so the cursor, put back at
    // the index it had (the end), stands after the new line.
    await ui.input({ key: box?.key ?? '', text: typed })
    const [after] = fields(await ui.drawn())
    expect(after?.key).toBe(box?.key)
    expect(after?.value.length).toBe(typed.length)
    expect(after?.value.endsWith('cut intro 12\n')).toBe(true)
    expect((kept.get(key) as Kept).blocks.map(b => b.text)).toEqual(['cut intro 12\n'])

    // A field with no stock left is replaced by a fresh one with the same text and a new line.
    await ui.input({ key: box?.key ?? '', text: 'cut intro 12\nsecond line' })
    const [fresh] = fields(await ui.drawn())
    expect(fresh?.key).not.toBe(box?.key)
    expect(fresh?.value.replaceAll(ZW, '')).toBe('cut intro 12\nsecond line\n')
    expect(fresh?.value.startsWith(ZW)).toBe(true)
    await ui.unmount()

    // Another session has its own, empty memo.
    session = 'b-' + surface
    const other = await $.ui.mount({ ...PANE, surface })
    expect(fields(await other.drawn()).map(f => f.value.replaceAll(ZW, ''))).toEqual([''])
    await other.unmount()
    expect(kept.has('pad:shared')).toBe(false)
  }
})

test('what earlier versions kept is shown in the box', async ($, on) => {
  let session = 'old1'
  const kept = world(on, () => session)
  kept.set('memo:old1', 'first note\n\nsecond note\n')
  kept.set('pad:old2', { blocks: [{ kind: 'text', id: 'x', text: 'posted text' }], tail: 'line in progress' })

  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(fields(await first.drawn()).map(f => f.value.replaceAll(ZW, ''))).toEqual(['first note\n\nsecond note\n'])
  await first.unmount()

  session = 'old2'
  const second = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(fields(await second.drawn()).map(f => f.value.replaceAll(ZW, ''))).toEqual(['posted text\nline in progress'])
  await second.unmount()
})

test('a chat message that starts with ㅁ goes into the memo and not to the model', async ($, on) => {
  const kept = world(on, () => 'note')
  const send = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

  // An ordinary message enters as typed, a word that only begins like the mark included.
  expect((await send('fix the memo')).drop).toBeUndefined()
  expect((await send('ㅁㅁ')).drop).toBeUndefined()
  expect(kept.has('pad:shared')).toBe(false)

  // A note is kept and dropped; the next one goes on the line under it.
  expect((await send('ㅁ fix this screen')).drop).toContain('Added to the memo')
  expect((await send('memo: second')).drop).toContain('Not sent to Claude')
  expect((kept.get('pad:shared') as Kept).blocks.map(b => b.text)).toEqual(['fix this screen\nsecond'])

  // The mark alone is nothing to keep.
  expect((await send('ㅁ')).drop).toContain('Nothing to add')
  expect((kept.get('pad:shared') as Kept).blocks.map(b => b.text)).toEqual(['fix this screen\nsecond'])

  // A screenshot that cannot be read is said so; the words are still kept.
  const res = await $.prompt.submit({ text: 'ㅁ third', wait: false, origin: { kind: 'composer' }, attachments: [{ type: 'image', mediaType: 'image/png', id: 'gone' }] })
  expect(res.drop).toContain('1 could not be read')
  expect((kept.get('pad:shared') as Kept).blocks.map(b => b.text)).toEqual(['fix this screen\nsecond\nthird'])
})

test('a screenshot stands under the writing with a box under it, is enlarged, and is taken out again', async ($, on) => {
  const kept = world(on, () => 'shots')
  const ran: string[] = []
  on('fs.read', (_, e) => ({ value: { base64: e.path.endsWith('-l.jpg') ? 'BIGBIG' : 'SMALL' } }))
  on('process.run', (_, e) => {
    ran.push(e.argv[0] ?? '')

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  kept.set('pad:shots', {
    blocks: [
      { kind: 'text', id: 't1', text: 'fix this screen' },
      { kind: 'shot', id: 'x1', png: '/p/x1.png', thumb: '/p/x1-s.jpg', big: '/p/x1-l.jpg', w: 300, h: 200, bw: 600, bh: 400 },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const boxes = fields(await ui.drawn())
  expect(boxes.map(f => f.value.replaceAll(ZW, ''))).toEqual(['fix this screen', ''])
  // The thumbnail is about five lines tall (110 px), so 165 px wide here.
  expect(JSON.stringify(await ui.drawn())).toContain('base64,SMALL')
  expect(JSON.stringify(await ui.drawn())).toContain('"width":165')

  // "Larger" draws the larger copy, "Smaller" the thumbnail again.
  await ui.press({ key: 'zoom-x1' })
  expect(JSON.stringify(await ui.drawn())).toContain('base64,BIGBIG')
  await ui.press({ key: 'zoom-x1' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('base64,BIGBIG')

  // Writing goes on in the box under the screenshot.
  await ui.input({ key: boxes[1]?.key ?? '', text: boxes[1]?.value + 'next line', kind: 'change' })
  expect((kept.get('pad:shared') as Kept).blocks.map(b => b.text)).toEqual(['fix this screen', undefined, 'next line'])

  // ✕ takes the screenshot out with its files, and the text round it is one box again.
  await ui.press({ key: 'drop-x1' })
  expect((kept.get('pad:shared') as Kept).blocks.map(b => b.text)).toEqual(['fix this screen\nnext line'])
  expect(fields(await ui.drawn()).length).toBe(1)
  expect(ran.at(-1)).toBe('rm')
  await ui.unmount()
})

test('a terminal shows a screenshot as its file path', async ($, on) => {
  const kept = world(on, () => 'term')
  kept.set('pad:term', { blocks: [{ kind: 'shot', id: 'x1', png: '/p/x1.png', thumb: '/p/x1-s.jpg', big: '/p/x1-l.jpg', w: 3, h: 2, bw: 6, bh: 4 }] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const lines = JSON.stringify(await ui.drawn())
  expect(lines).toContain('/p/x1.png')
  expect(lines).not.toContain('"type":"Svg"')
  await ui.unmount()
})
