import type { PluginCatalogRelease } from '../../../shared/plugins/catalog/plugin-catalog-release'
import { readPluginImageHeader } from '../../../shared/plugins/images/plugin-image-format'
import {
  PLUGIN_IMAGE_RULES,
  pluginImageRuleError,
  type PluginCatalogImages
} from '../../../shared/plugins/images/plugin-image-fields'
import type {
  PluginMarketplace,
  PluginMarketplaceEntry
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { sha256Hex } from '../media/plugin-image-cache'
import { offeredCatalogRelease } from './plugin-marketplace-projection'

// Why a catalog-wide cap: a large catalog must not turn one refresh into an unbounded download.
const CATALOG_IMAGES_MAX_BYTES = 64 * 1024 * 1024

type CatalogImage = NonNullable<PluginCatalogImages['cover']>

export type CatalogBlobReader = (path: string, maxBytes: number) => Promise<Buffer | null>

/** Gives an entry images before they are checked. */
export type CatalogEntryImageFill = (
  entry: PluginMarketplaceEntry,
  readBlob: CatalogBlobReader
) => Promise<PluginMarketplaceEntry>

type ImageUse = {
  release: PluginCatalogRelease
  kind: 'icon' | 'cover' | 'screenshot'
  image: CatalogImage
  // Spending order: offered cards, offered screenshots, other cards, other screenshots.
  tier: number
  // Screenshot position, so every plugin's first screenshot is paid before any plugin's second.
  turn: number
}

function imageUses(entry: PluginMarketplaceEntry, hostVersion: string | null): ImageUse[] {
  const offered = offeredCatalogRelease(entry.releases, hostVersion)
  const uses: ImageUse[] = []
  for (const release of entry.releases ?? []) {
    const images = release.images
    if (!images) {
      continue
    }
    const tier = release === offered ? 0 : 2
    for (const kind of ['icon', 'cover'] as const) {
      const image = images[kind]
      if (image) {
        uses.push({ release, kind, image, tier, turn: 0 })
      }
    }
    for (const [turn, image] of (images.screenshots ?? []).entries()) {
      uses.push({ release, kind: 'screenshot', image, tier: tier + 1, turn })
    }
  }
  return uses
}

/**
 * Reads every image a catalog references from the catalog repository at its commit, keeps the
 * ones whose bytes match their hash, size and format, and drops the rest from the listing.
 * The byte cap is spent on what cards show first, so plugin order never decides who gets a cover.
 */
export async function extractCatalogImages(
  marketplace: PluginMarketplace,
  readBlob: CatalogBlobReader,
  fill?: CatalogEntryImageFill,
  hostVersion: string | null = null
): Promise<{ marketplace: PluginMarketplace; images: Buffer[] }> {
  const entries: PluginMarketplaceEntry[] = []
  for (const listed of marketplace.plugins) {
    entries.push(fill ? await fill(listed, readBlob) : listed)
  }
  const kept = new Map<string, Buffer>()
  // Why keyed per use: bytes that fail one kind's rules (a non-square icon) can be a valid screenshot.
  const rejected = new Set<string>()
  let budget = CATALOG_IMAGES_MAX_BYTES
  const check = async ({ image, kind }: ImageUse): Promise<boolean> => {
    const key = `${kind}:${image.sha256}:${image.width}x${image.height}`
    if (rejected.has(key)) {
      return false
    }
    let bytes = kept.get(image.sha256) ?? null
    const paid = bytes !== null
    if (!paid) {
      const maxBytes = Math.min(PLUGIN_IMAGE_RULES[kind].maxBytes, budget)
      bytes = maxBytes > 0 ? await readBlob(image.path, maxBytes).catch(() => null) : null
    }
    const info = bytes ? readPluginImageHeader(bytes) : 'missing'
    const ok =
      bytes !== null &&
      typeof info !== 'string' &&
      (paid || sha256Hex(bytes) === image.sha256) &&
      info.width === image.width &&
      info.height === image.height &&
      pluginImageRuleError(kind, info, bytes.byteLength) === null
    if (!ok) {
      rejected.add(key)
    } else if (!paid && bytes) {
      budget -= bytes.byteLength
      kept.set(image.sha256, bytes)
    }
    return ok
  }
  const uses = entries.flatMap((entry) => imageUses(entry, hostVersion))
  // Stable sort: catalog order is kept inside each tier and turn.
  uses.sort((a, b) => a.tier - b.tier || a.turn - b.turn)
  const accepted = new Set<ImageUse>()
  for (const use of uses) {
    if (await check(use)) {
      accepted.add(use)
    }
  }
  const byRelease = new Map<PluginCatalogRelease, ImageUse[]>()
  for (const use of uses) {
    const list = byRelease.get(use.release)
    if (list) {
      list.push(use)
    } else {
      byRelease.set(use.release, [use])
    }
  }
  const plugins = entries.map((entry) =>
    entry.releases
      ? {
          ...entry,
          releases: entry.releases.map((release) =>
            keptRelease(release, byRelease.get(release) ?? [], accepted)
          )
        }
      : entry
  )
  return { marketplace: { ...marketplace, plugins }, images: [...kept.values()] }
}

function keptRelease(
  release: PluginCatalogRelease,
  uses: readonly ImageUse[],
  accepted: ReadonlySet<ImageUse>
): PluginCatalogRelease {
  if (!release.images) {
    return release
  }
  const { images: _images, ...rest } = release
  const ok = uses.filter((use) => accepted.has(use))
  const icon = ok.find((use) => use.kind === 'icon')?.image
  const cover = ok.find((use) => use.kind === 'cover')?.image
  const screenshots = ok
    .filter((use) => use.kind === 'screenshot')
    .sort((a, b) => a.turn - b.turn)
    .map((use) => use.image)
  const images: PluginCatalogImages = {
    ...(icon ? { icon } : {}),
    ...(cover ? { cover } : {}),
    ...(screenshots.length ? { screenshots } : {})
  }
  return Object.keys(images).length ? { ...rest, images } : rest
}
