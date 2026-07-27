// Perceptual hashing (dHash) for "these look visually similar" matching —
// distinct from the exact-duplicate MD5 comparison elsewhere in the app.
// dHash: shrink to a small grid, compare each pixel to its right-hand
// neighbor, one bit per comparison. Robust to recompression/resizing/minor
// color shifts; not robust to cropping or rotation — approximate by design.

const GRID = 8 // 8x8 output bits = 64-bit hash

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
    img.src = src
  })
}

export async function computeDHash(imageUrl: string): Promise<bigint> {
  const img = await loadImage(imageUrl)

  const canvas = document.createElement('canvas')
  canvas.width = GRID + 1
  canvas.height = GRID
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable.')
  ctx.drawImage(img, 0, 0, GRID + 1, GRID)

  const { data } = ctx.getImageData(0, 0, GRID + 1, GRID)
  const gray: number[] = []
  for (let i = 0; i < data.length; i += 4) {
    gray.push((data[i] + data[i + 1] + data[i + 2]) / 3)
  }

  // BigInt(0)/BigInt(1) rather than 0n/1n literals — literal syntax needs a
  // newer TS `target` than this project's ES2017.
  let hash = BigInt(0)
  let bit = BigInt(0)
  const one = BigInt(1)
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const idx = y * (GRID + 1) + x
      if (gray[idx] > gray[idx + 1]) hash |= one << bit
      bit += one
    }
  }
  return hash
}

export function hammingDistance(a: bigint, b: bigint): number {
  const zero = BigInt(0)
  const one = BigInt(1)
  let x = a ^ b
  let count = 0
  while (x > zero) {
    count += Number(x & one)
    x >>= one
  }
  return count
}

// Union-find clustering: groups items whose hash is within `maxDistance` of
// at least one other member of the same group (transitive — A~B~C can end
// up in one group even if A and C alone exceed the threshold).
export function clusterBySimilarity<T>(
  items: { item: T; hash: bigint }[],
  maxDistance: number
): T[][] {
  const n = items.length
  const parent = Array.from({ length: n }, (_, i) => i)

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  function union(a: number, b: number) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (hammingDistance(items[i].hash, items[j].hash) <= maxDistance) {
        union(i, j)
      }
    }
  }

  const groups = new Map<number, T[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const arr = groups.get(root) ?? []
    arr.push(items[i].item)
    groups.set(root, arr)
  }

  return [...groups.values()].filter((g) => g.length > 1)
}
