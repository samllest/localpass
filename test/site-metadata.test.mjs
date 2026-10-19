import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capturedSite,
  normalizeSiteMetadata,
  websiteAddress,
  safeIconData
} from '../src/shared/site-metadata.js'
import { filterGroups, groupAccounts, recordWebsiteUrl } from '../src/renderer/src/utils/vault.js'

test('capture recovers ports from page URLs, including older host-only submissions', () => {
  const site = capturedSite({
    identity: '10.0.15.33',
    page_url: 'http://10.0.15.33:3000/login?token=private',
    site_name: 'Agent Router',
    page_title: 'Agent Router · 登录'
  })
  assert.equal(site.identity, '10.0.15.33:3000')
  assert.equal(site.site_url, 'http://10.0.15.33:3000')
  assert.equal(site.display_name, 'Agent Router')
  assert.equal(site.page_title, 'Agent Router · 登录')
  assert.ok(!JSON.stringify(site).includes('private'))
  assert.equal(capturedSite({ page_url: 'https://[::1]:8443/login' }).identity, '[::1]:8443')
  assert.equal(websiteAddress('[::1]:3000').origin, 'http://[::1]:3000')
})

test('site names and tab titles are searchable; ports stay separate', () => {
  const groups = groupAccounts(
    [3000, 8080].map((port) => ({
      id: port,
      identity: `10.0.15.33:${port}`,
      category: 'web',
      display_name: 'Custom',
      site_name: 'Agent Router',
      page_title: 'API 控制台',
      site_url: `http://10.0.15.33:${port}`
    }))
  )
  assert.equal(groups.length, 2)
  assert.equal(filterGroups(groups, 'Agent Router').length, 2)
  assert.equal(filterGroups(groups, '控制台').length, 2)
  assert.equal(filterGroups(groups, ':3000').length, 1)
  assert.equal(recordWebsiteUrl(groups[0]), 'http://10.0.15.33:3000')
})

test('website links preserve protocols and cannot silently cross ports', () => {
  assert.equal(
    recordWebsiteUrl({ identity: 'example.com:8080', site_url: 'http://example.com:8080' }),
    'http://example.com:8080'
  )
  assert.equal(
    normalizeSiteMetadata({ site_url: 'http://example.com:3000' }, 'example.com:8080').site_url,
    ''
  )
  assert.throws(() => capturedSite({ page_url: 'javascript:alert(1)' }))
  assert.equal(
    capturedSite({ page_url: 'https://example.com', page_title: 'Agent Router' }).display_name,
    'Agent Router'
  )
})

test('vault icons only accept bounded PNG data, never remote or active SVG content', () => {
  assert.equal(safeIconData('https://example.com/icon.png'), '')
  assert.equal(safeIconData('data:image/svg+xml,<svg onload="alert(1)"/>'), '')
  assert.equal(safeIconData('data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(25000)), '')
})
