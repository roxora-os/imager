import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ActionList, ActionListGroup, ActionListItem, Alert, AlertActionCloseButton, AlertActionLink, Button, CodeBlock, CodeBlockAction, CodeBlockCode, Content, DescriptionList,
  DescriptionListDescription, DescriptionListGroup, DescriptionListTerm, EmptyState, EmptyStateActions, EmptyStateBody,
  EmptyStateFooter, ExpandableSection, Flex, FlexItem, Form, FormGroup, FormHelperText, FormSection, FormSelect, FormSelectOption,
  Checkbox, HelperText, HelperTextItem, List, ListItem, Masthead, Menu, MenuContent, MenuItem, MenuList,
  MastheadBrand, MastheadContent, MastheadLogo, MastheadMain, Modal, ModalBody, ModalFooter, ModalHeader, Page,
  PageSection, Progress, ProgressMeasureLocation, Radio, SearchInput, Sidebar, SidebarContent, SidebarPanel, SimpleList,
  SimpleListItem,
  Spinner, Stack, StackItem, Switch, Title, ToggleGroup, ToggleGroupItem, Toolbar, ToolbarContent, ToolbarGroup,
  ToolbarItem, Wizard, WizardFooterWrapper, WizardStep,
  useWizardContext,
} from '@patternfly/react-core';
import { CogIcon } from '@patternfly/react-icons/dist/esm/icons/cog-icon';
import { GlobeIcon } from '@patternfly/react-icons/dist/esm/icons/globe-icon';
import { TimesIcon } from '@patternfly/react-icons/dist/esm/icons/times-icon';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import {
  compareImages, flavorWords, groupByBoard, splitByRelease, type Board, type CatalogImage, type CatalogRelease, type ImageSortKey,
} from '../shared/catalog';
import { BOARD_REQUEST_URL, queryWords, vendorCounts, visibleBoards } from '../shared/boardsearch';
import { formatBytes, uncompressedName } from '../shared/format';
import type { CatalogResult, ImagerApi, JobProgress, LocalImage, PreparedFile, ProblemFacts, SaveSubject, SaveTarget, UpdateImageFile } from '../shared/ipc';
import type { CacheInfo } from '../main/cache';
import { INTERNAL_WORDS, type HiddenDrive, type Target } from '../shared/targets';
import { APT_COMMAND, brewCommand, type UpdateCheck, type UpdateOffer, type UpdateResult } from '../shared/update';
import { CHANNELS, type Channel } from '../shared/channel';
import { maskromBoard, STORAGES, type StorageId } from '../maskrom/boards';
import { RKBIN_HOST } from '../maskrom/loaders';
import { SPI_FLASH_FALLBACK, spiFileProblem } from '../maskrom/spi-check';
import { BOARD_GONE, type Stage } from '../maskrom/sequence';
import { startMaskrom, type MaskromJob } from './maskrom-client';
import { maskromStatus, ROCKCHIP_VID, type MaskromStatus, type SeenDevice } from '../shared/maskrom-detect';
import { readTheme, applyTheme, type Theme } from './theme';
import { msg, t, useI18n } from './i18n';
import { LANG_NAMES, LANGS, type Lang } from '../shared/i18n';

declare global {
  interface Window { imager: ImagerApi }
  interface Navigator {
    usb: { requestDevice(o: { filters: { vendorId: number }[] }): Promise<unknown>; getDevices(): Promise<unknown[]> };
  }
}
const api = window.imager;
// The web build writes over Maskrom only: a browser cannot open a disk.
const WEB = api.platform === 'web';
// The web build is told at build time whether the desktop app has a release
// yet (scripts/build-web.mjs); until then "desktop app" points at the install
// notes, not at an empty releases page.
declare const __APP_HAS_RELEASE__: boolean;
const DESKTOP_URL = typeof __APP_HAS_RELEASE__ !== 'undefined' && !__APP_HAS_RELEASE__
  ? 'https://github.com/roxora-os/imager#install' : 'https://github.com/roxora-os/imager/releases';
const RPI_IMAGER_URL = 'https://www.raspberrypi.com/software/';
// Rockchip's loader is not shipped with the app (maskrom/loaders.ts).
const loaderNote = () => t("The first Maskrom write downloads Rockchip's loader from {host} (rockchip-linux/rkbin) and checks it.", { host: RKBIN_HOST });

type Method = 'sd' | 'maskrom' | 'file';
type MaskromSource = 'release' | 'spi' | 'file' | 'update';
/** A release file being downloaded or checked: what, and how far. */
interface Checking { label: string; done: number; total: number }

interface Run {
  kind: Method;
  /** `done`: what to show in place of a percentage that is not known (bytes so far). */
  stages: { id: string; label: string; percent: number | null; detail?: string; done?: string }[];
  log: string[];
  /**
   * reason: the English reason, for a problem report. gone: the board left
   * the USB bus during the write (maskrom/sequence.ts BOARD_GONE).
   */
  result: { ok: boolean; warning?: boolean; title: string; text: string; detail?: string; reason?: string; gone?: boolean } | null;
  /** A save to a file: its token, for Show in folder. */
  saved?: string;
  /** A write over Maskrom: the board, to show how to put it back into Maskrom mode. */
  board?: { name: string; soc: string };
  /** Where the copy of the SPI NOR flash taken before the write was kept. */
  backup?: string;
}

const RELEASES_URL = 'https://github.com/roxora-os/build/releases';

/** A UEFI image (release contract: board `generic-<soc>-uefi`), for boards with UEFI firmware instead of a board of its own. */
function isUefiImage(img: CatalogImage | undefined): boolean {
  return !!img && /^generic-.*-uefi$/.test(img.board);
}

/*
 * Where a saved .img boots, said plainly: a board image only on its board;
 * the UEFI image on arm64 UEFI firmware, so in a virtual machine an arm64
 * one, and with Ventoy an arm64 UEFI computer. Never an x86 PC.
 */
const uefiVm = () => t('an arm64 (aarch64) UEFI machine, such as QEMU virt with edk2 (AAVMF) or UTM on Apple silicon');
/** One line on what an update.img holds. */
function updateWords(f: UpdateImageFile): string {
  const u = f.update;
  const who = [u.manufacturer, u.model].filter(Boolean).join(' ');
  return t('{chip}{who}, version {version} of {date}: {parts}', { chip: u.chip, who: who ? `, ${who}` : '', version: u.version, date: u.released, parts: u.partitions.map((x) => x.name).join(', ') })
    + (u.skipped.length ? t(' (not written: {parts})', { parts: u.skipped.join(', ') }) : '')
    + t('. ') + (f.md5Checked ? t('Its MD5 matches.') : t('It carries no MD5 to check.'));
}

function bootNote(img: CatalogImage | undefined, custom: boolean): string {
  if (custom) {
    return t('Where it boots depends on the image: a Roxora board image only on its board, the generic RK3576 UEFI image in {vm}. Not on an x86 PC.', { vm: uefiVm() });
  }
  if (isUefiImage(img)) {
    return t('This UEFI image boots in {vm}, and from Ventoy only on an arm64 UEFI computer. Not on an x86 PC.', { vm: uefiVm() });
  }
  return (img ? t('This image boots only on the {board}.', { board: img.boardName }) : t('A board image boots only on its board.'))
    + t(' For a virtual machine or Ventoy use the generic RK3576 UEFI image, which needs {vm}. Neither boots on an x86 PC.', { vm: uefiVm() });
}

/** The last part of a path, for Windows paths as well. */
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** What a Maskrom write takes by default: the whole image where it fits, else the release's SPI bootloader, else a file. */
function defaultSource(m: ReturnType<typeof maskromBoard>, img: CatalogImage | undefined): MaskromSource {
  if (m?.imageStorage) return 'release';
  if (img?.spi && m?.storages.includes('spinor')) return 'spi';
  return 'file';
}

function releaseWords(img: CatalogImage): string {
  return img.releaseInfo.prerelease ? t('Beta {version}', { version: img.releaseInfo.version }) : t('Release {version}', { version: img.releaseInfo.version });
}

/*
 * The page shell, laid out as Fedora's installer (anaconda-webui) does it:
 * a masthead, then one wizard that fills the rest of the window, its step
 * nav running the full height and its footer pinned to the bottom.
 */
function Shell({ children, onSettings }: { children: React.ReactNode; onSettings: () => void }) {
  const { lang } = useI18n();
  const [langOpen, setLangOpen] = useState(false);
  const masthead = (
    <Masthead display={{ default: 'inline' }}>
      <MastheadMain>
        <MastheadBrand>
          <MastheadLogo component="span" className="brand">
            <img src="resources/roxora-mark.svg" alt="" className="brand-mark" />
            <span className="brand-name">Roxora Imager</span>
          </MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar isFullHeight isStatic>
          <ToolbarContent>
            <ToolbarGroup align={{ default: 'alignEnd' }}>
              <ToolbarItem>
                <Button variant="plain" icon={<GlobeIcon />} aria-label={t('Display language')} title={t('Display language')}
                  onClick={() => setLangOpen(true)}>
                  <span lang={lang}>{LANG_NAMES[lang]}</span>
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button variant="plain" icon={<CogIcon />} onClick={onSettings}>{t('Settings')}</Button>
              </ToolbarItem>
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );
  return (
    <Page masthead={masthead} isContentFilled>
      {children}
      {langOpen && <LangModal onClose={() => setLangOpen(false)} />}
    </Page>
  );
}

/*
 * The language dialog, as Cockpit's "Display language" (shell-modals.jsx)
 * and Maskrom Studio's: a small modal with a plain menu of the languages,
 * each in its own language, the current one selected, and Select / Cancel.
 */
function LangModal({ onClose }: { onClose: () => void }) {
  const { lang, setLang } = useI18n();
  const [picked, setPicked] = useState<Lang>(lang);
  const apply = () => { if (picked !== lang) setLang(picked); onClose(); };
  return (
    <Modal isOpen variant="small" onClose={onClose} aria-labelledby="lang-dialog-title" id="lang-dialog">
      <ModalHeader title={t('Display language')} labelId="lang-dialog-title" />
      <ModalBody>
        <Menu isPlain isScrollable activeItemId={picked} selected={picked} onSelect={(_e, id) => setPicked(id as Lang)}>
          <MenuContent>
            <MenuList>
              {LANGS.map((l) => <MenuItem key={l} itemId={l} isSelected={picked === l} lang={l}>{LANG_NAMES[l]}</MenuItem>)}
            </MenuList>
          </MenuContent>
        </Menu>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={apply}>{t('Select')}</Button>
        <Button variant="link" onClick={onClose}>{t('Cancel')}</Button>
      </ModalFooter>
    </Modal>
  );
}

/** One wizard step's content: title, optional lead, notices, then the step itself. */
function StepPage({ title, lead, notices, children }: {
  title: string; lead?: React.ReactNode; notices?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <Stack hasGutter className="step">
      <StackItem>
        <Title headingLevel="h2">{title}</Title>
        {lead && <Content component="p" className="step-lead">{lead}</Content>}
      </StackItem>
      {notices}
      {children}
    </Stack>
  );
}

/** What the Board and Image steps need to offer an image file on this computer (desktop only). */
interface LocalPick {
  local: LocalImage | null; busy: boolean; error: string | null; pick: () => void; clear: () => void;
}
const localButton = () => t('Use an image file on this computer');

/** The file chosen for the SD/USB path, and plainly whether a release vouches for it. */
function LocalImageRow({ lp }: { lp: LocalPick }) {
  if (!api.pickLocalImage) return null;
  const { local } = lp;
  return (
    <Stack hasGutter className="local-image">
      <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
        <FlexItem flex={{ default: 'flexNone' }}>
          <Button variant="secondary" onClick={lp.pick} isLoading={lp.busy} isDisabled={lp.busy}>{localButton()}</Button>
        </FlexItem>
        <FlexItem>
          {local ? `${local.name}, ${formatBytes(local.size)}`
            : t('A downloaded .img, .img.xz, .img.gz or .img.bz2, for an SD card or USB drive. You can also drop the file on this window.')}
        </FlexItem>
        {local && <FlexItem><Button variant="link" isInline onClick={lp.clear}>{t('Remove')}</Button></FlexItem>}
      </Flex>
      {lp.error && <Alert variant="danger" isInline isPlain title={lp.error} />}
      {local && !local.imageId && (
        <Alert isInline variant="warning" title={t('Not a Roxora release image')}>
          {t('{name} is not a file of the Roxora releases listed here, so it was not checked against one. It is written as it is; afterwards the drive is read back and compared with the file.', { name: local.name })}
        </Alert>
      )}
      {local?.imageId && (
        <Alert isInline variant="success" title={t('This file is the release image selected above')}>
          {t('Its SHA-256 matches the release. It is written from this computer, without a download.')}
        </Alert>
      )}
    </Stack>
  );
}

/** Moves the wizard to a step when the app asks for it (a file was chosen or dropped). */
function Jump({ to, done }: { to: string | null; done: () => void }) {
  const ctx = useWizardContext();
  useEffect(() => {
    if (!to) return;
    ctx?.goToStepById?.(to);
    done();
  }, [to]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

interface FindState { query: string; setQuery: (q: string) => void; vendor: string; setVendor: (v: string) => void }

function BoardStep({ catalog, boards, board, setBoard, reload, find, notices, lp }: {
  catalog: CatalogResult | null; boards: Board[]; board: string | null;
  setBoard: (b: string) => void; reload: () => void; find: FindState; notices: React.ReactNode; lp: LocalPick;
}) {
  // Without the release list a downloaded image can still be written.
  const localAction = api.pickLocalImage && (
    <Button variant="secondary" onClick={lp.pick} isLoading={lp.busy} isDisabled={lp.busy}>{localButton()}</Button>
  );
  const localError = lp.error && <EmptyStateBody><Alert variant="danger" isInline isPlain title={lp.error} /></EmptyStateBody>;
  if (!catalog) return <EmptyState titleText={t('Loading releases')} headingLevel="h2" icon={Spinner} />;
  if (catalog.state === 'error') {
    return (
      <EmptyState titleText={t('Could not load the releases')} headingLevel="h2">
        <EmptyStateBody>{msg(catalog.message)}</EmptyStateBody>
        {localError}
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="secondary" onClick={reload}>{t('Try again')}</Button>
            {localAction}
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  }
  if (catalog.state === 'none') {
    return (
      <EmptyState titleText={t('No Roxora releases yet')} headingLevel="h2">
        <EmptyStateBody>
          {t('Roxora images are published as releases of roxora-os/build. There are none yet, so there is nothing to write. This list fills itself once the first release is out.')}
        </EmptyStateBody>
        {localError}
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="secondary" onClick={reload}>{t('Check again')}</Button>
            {localAction}
            <Button variant="link" component="a" href={RELEASES_URL} target="_blank">{t('Releases on GitHub')}</Button>
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  }
  return (
    <StepPage title={t('Board')} notices={notices} lead={api.pickLocalImage ? (
      <>
        {t('Choose the board you want to install Roxora on. Already downloaded an image?')}{' '}
        <Button variant="link" isInline onClick={lp.pick} isDisabled={lp.busy}>{localButton()}</Button>
      </>
    ) : t('Choose the board you want to install Roxora on.')}>
      {lp.error && <Alert variant="danger" isInline isPlain title={lp.error} />}
      <BoardPicker boards={boards} board={board} setBoard={setBoard} find={find} />
    </StepPage>
  );
}

const ALL = '__all';

/*
 * The search, then PatternFly's Sidebar layout: the vendor list as a panel
 * beside the boards table (a select above it below md). No dividing line:
 * the list and the table are as long as their contents, and a line beside
 * them would stop short of the footer.
 */
function BoardPicker({ boards, board, setBoard, find }: {
  boards: Board[]; board: string | null; setBoard: (b: string) => void; find: FindState;
}) {
  const { query, setQuery, vendor, setVendor } = find;
  const searching = queryWords(query).length > 0;
  const counts = useMemo(() => vendorCounts(boards, query), [boards, query]);
  const shown = useMemo(() => visibleBoards(boards, vendor === ALL ? null : vendor, query), [boards, vendor, query]);
  const total = searching ? shown.length : boards.length;
  const box = useRef<HTMLDivElement>(null);
  // Ready to type into, without the keyboard focus ring until the user moves
  // focus with the keyboard.
  useEffect(() => { box.current?.querySelector<HTMLInputElement>('input')?.focus({ focusVisible: false } as FocusOptions); }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && searching && shown.length === 1) {
      e.preventDefault();
      setBoard(shown[0].board);
    }
  };
  const vendorLabel = (v: string, n: number) => `${v} (${n})`;
  // A search covers every vendor, so the list shows "All vendors" while one
  // runs; picking a vendor ends the search.
  const active = searching ? ALL : vendor;
  const pick = (v: string) => { setVendor(v); if (searching) setQuery(''); };
  const vendorItem = (id: string, name: string, n: number, disabled = false) => (
    <SimpleListItem key={id} itemId={id} isActive={active === id}
      componentProps={{ disabled, 'aria-pressed': active === id }}>
      <Flex justifyContent={{ default: 'justifyContentSpaceBetween' }} flexWrap={{ default: 'nowrap' }}>
        <FlexItem>{name}</FlexItem>
        <FlexItem className="vendor-count">{n}</FlexItem>
      </Flex>
    </SimpleListItem>
  );

  return (
    <Stack hasGutter>
      <div ref={box} onKeyDown={onKeyDown} className="board-search">
        <SearchInput placeholder={t('Search boards, vendors or SoCs')} value={query} aria-label={t('Search boards, vendors or SoCs')}
          onChange={(_e, v) => setQuery(v)} onClear={() => setQuery('')} />
      </div>
      <Sidebar hasGutter>
        <SidebarPanel width={{ default: 'width_25' }}>
          <div className="vendor-select">
            <FormSelect value={active} onChange={(_e, v) => pick(v)} aria-label={t('Vendor')}>
              <FormSelectOption value={ALL} label={vendorLabel(t('All vendors'), total)} />
              {counts.map((c) => (
                <FormSelectOption key={c.vendor} value={c.vendor} label={vendorLabel(c.vendor, c.count)} isDisabled={searching && c.count === 0} />
              ))}
            </FormSelect>
          </div>
          <nav className="vendor-list" aria-label={t('Vendors')}>
            <SimpleList onSelect={(_ref, props) => pick(String(props.itemId ?? ALL))} isControlled={false}>
              {vendorItem(ALL, t('All vendors'), total)}
              {counts.map((c) => vendorItem(c.vendor, c.vendor, c.count, searching && c.count === 0))}
            </SimpleList>
          </nav>
        </SidebarPanel>
        <SidebarContent>
          {shown.length === 0 ? (
            <EmptyState titleText={t('No board matches “{query}”', { query: query.trim() })} headingLevel="h3" variant="sm">
              <EmptyStateFooter>
                <EmptyStateActions>
                  <Button variant="link" component="a" href={BOARD_REQUEST_URL} target="_blank">{t('Ask for a board to be supported')}</Button>
                  <Button variant="link" onClick={() => setQuery('')}>{t('Clear the search')}</Button>
                </EmptyStateActions>
              </EmptyStateFooter>
            </EmptyState>
          ) : (
            <Table aria-label={t('Boards')} variant="compact">
              <Thead><Tr><Th screenReaderText={t('Select')} /><Th>{t('Board')}</Th><Th>SoC</Th><Th>{t('Newest image')}</Th></Tr></Thead>
              <Tbody>
                {shown.map((b, i) => (
                  <Tr key={b.board} isClickable onRowClick={() => setBoard(b.board)} isRowSelected={board === b.board}>
                    <Td select={{ rowIndex: i, variant: 'radio', isSelected: board === b.board, onSelect: () => setBoard(b.board) }} />
                    <Td dataLabel={t('Board')} className="nowrap-md">{b.boardName}</Td>
                    <Td dataLabel="SoC" className="nowrap-md">{b.soc.toUpperCase()}</Td>
                    <Td dataLabel={t('Newest image')}>{releaseWords(b.images[0])}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </SidebarContent>
      </Sidebar>
    </Stack>
  );
}

// The release is named above each table, so it is no column.
// Fixed widths, so the newest release's table and an older one line up.
const IMAGE_COLUMNS: [ImageSortKey, string, 15 | 20 | 25 | 30][] = [
  ['ubuntu', 'Ubuntu', 25], ['desktop', 'Desktop', 30], ['kernel', 'Kernel', 25], ['size', 'Size', 15],
];

type ImageSort = { key: ImageSortKey; dir: 'asc' | 'desc' } | null;

function releaseLabel(r: CatalogRelease): string {
  return t(r.prerelease ? 'Beta {version} ({date})' : 'Release {version} ({date})', { version: r.version, date: r.date });
}

function ImageTable({ label, images, selected, setImage, sort, setSort }: {
  label: string; images: CatalogImage[]; selected: string | null; setImage: (id: string) => void;
  sort: ImageSort; setSort: (s: ImageSort) => void;
}) {
  const rows = sort ? [...images].sort((x, y) => (sort.dir === 'asc' ? 1 : -1) * compareImages(x, y, sort.key)) : images;
  return (
    <Table aria-label={label} variant="compact">
      <Thead><Tr><Th screenReaderText={t('Select')} />
        {IMAGE_COLUMNS.map(([key, name, width], col) => (
          <Th key={key} width={width} sort={{
            columnIndex: col + 1,
            sortBy: sort ? { index: IMAGE_COLUMNS.findIndex(([k]) => k === sort.key) + 1, direction: sort.dir } : {},
            onSort: (_e, _i, dir) => setSort({ key, dir }),
          }}>{t(name)}</Th>
        ))}
      </Tr></Thead>
      <Tbody>
        {rows.map((img, i) => (
          <Tr key={img.id} isClickable onRowClick={() => setImage(img.id)} isRowSelected={selected === img.id}>
            <Td select={{ rowIndex: i, variant: 'radio', isSelected: selected === img.id, onSelect: () => setImage(img.id) }} />
            <Td dataLabel={t('Ubuntu')}>{img.ubuntuVersion} ({img.release})</Td>
            <Td dataLabel={t('Desktop')}>{t(flavorWords(img.flavor))}</Td>
            <Td dataLabel={t('Kernel')}>{img.kernel ? `${img.kernel} ` : ''}{img.branch}</Td>
            <Td dataLabel={t('Size')}>{formatBytes(img.size)}</Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
}

function ImageStep({ board, imageId, setImage, lp }: {
  board: Board | undefined; imageId: string | null; setImage: (id: string) => void; lp: LocalPick;
}) {
  // Sorting by a column header; none means the default order (newest
  // Ubuntu LTS, command line, edge).
  const [sort, setSort] = useState<ImageSort>(null);
  // Only the newest release is shown; older releases and betas are folded
  // away, one release at a time.
  const [olderOpen, setOlderOpen] = useState(false);
  const [olderTag, setOlderTag] = useState<string | null>(null);
  if (!board && !lp.local) return null;
  // A custom file takes the place of a release image; a file that is a
  // release image keeps that image selected.
  const custom = !!lp.local && !lp.local.imageId;
  const selected = custom ? null : imageId;
  const sel = board?.images.find((i) => i.id === selected);
  const { current, others } = splitByRelease(board?.images ?? []);
  const selOlder = !!sel && sel.releaseInfo.tag !== current?.release.tag;
  // A selected image of an older release keeps its release open.
  const older = others.find((r) => r.release.tag === (olderTag ?? (selOlder ? sel!.releaseInfo.tag : null))) ?? others[0];
  const tableProps = { selected, setImage, sort, setSort };
  return (
    <StepPage title={t('Image')} lead={!board ? t('No board is chosen, so no release images are listed.')
      : current ? <>{t(current.release.prerelease ? 'Images for {board} from Roxora {version} (a beta), released {date}.' : 'Images for {board} from Roxora {version}, released {date}.',
        { board: board.boardName, version: current.release.version, date: current.release.date })}{' '}
        <Button variant="link" isInline component="a" href={current.release.url} target="_blank">{t('Release notes')}</Button></>
      : t('Images for {board}.', { board: board.boardName })}>
      {current && <ImageTable label={t('Images of Roxora {version}', { version: current.release.version })} images={current.images} {...tableProps} />}
      {older && (
        <ExpandableSection className="older-releases" isExpanded={olderOpen || selOlder}
          onToggle={(_e, open) => setOlderOpen(open)}
          toggleText={t('Older releases and betas ({n})', { n: others.length })}>
          <Stack hasGutter>
            <FormGroup label={t('Release')} fieldId="older-release">
              <FormSelect id="older-release" value={older.release.tag} onChange={(_e, v) => setOlderTag(v)}>
                {others.map((r) => <FormSelectOption key={r.release.tag} value={r.release.tag} label={releaseLabel(r.release)} />)}
              </FormSelect>
            </FormGroup>
            <Alert isInline isPlain variant="info" title={older.release.prerelease
              ? t('A beta: optional, for trying what comes next.')
              : current ? t('An older release: Roxora {version} is the safer choice.', { version: current.release.version }) : t('An older release: the newest release is the safer choice.')}>
              <Button variant="link" isInline component="a" href={older.release.url} target="_blank">{t('Release notes')}</Button>
            </Alert>
            <ImageTable label={t('Images of Roxora {version}', { version: older.release.version })} images={older.images} {...tableProps} />
          </Stack>
        </ExpandableSection>
      )}
      {sel && selOlder && (
        <Content component="p" className="step-lead">
          {t(sel.releaseInfo.prerelease ? 'Selected: {release}, an image of a beta.' : 'Selected: {release}, an image of an older release.', { release: releaseWords(sel) })}
        </Content>
      )}
      <LocalImageRow lp={lp} />
    </StepPage>
  );
}

function DriversNote() {
  if (WEB) {
    return (
      <Content component="p">
        {t('On Windows the board needs the WinUSB driver: install it once with')}{' '}
        <Button variant="link" isInline component="a" href="https://zadig.akeo.ie/" target="_blank">Zadig</Button>{' '}
        {t('(the device with ID 2207, WinUSB, Install Driver). On Linux your user needs access to the device, for example through a udev rule for vendor 2207 with TAG+="uaccess". macOS needs nothing.')}
      </Content>
    );
  }
  if (api.platform === 'win32') {
    return (
      <Content component="p">
        {t("Windows needs the WinUSB driver for the board in Maskrom mode. Install it once with Zadig: choose the device with ID 2207 in Zadig's list, select WinUSB and click Install Driver.")}{' '}
        <Button variant="link" isInline component="a" href="https://zadig.akeo.ie/" target="_blank">zadig.akeo.ie</Button>
      </Content>
    );
  }
  if (api.platform === 'linux') {
    return (
      <>
        <Content component="p">
          {t('The .deb and .rpm packages install a udev rule that lets you use the board without root. With the AppImage, add the rule once:')}
        </Content>
        <CopyBlock text={'echo \'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/70-roxora-imager.rules\nsudo udevadm control --reload-rules && sudo udevadm trigger'} />
      </>
    );
  }
  return <Content component="p">{t('macOS needs no driver.')}</Content>;
}

/** How a board gets into Maskrom mode. */
function ConnectSteps() {
  return (
    <ol>
      <li>{t('Disconnect power from the board.')}</li>
      <li>{t("Hold the Maskrom button and connect the board's USB-C port to this computer.")}</li>
      <li>{t('Release the button after two seconds.')}</li>
    </ol>
  );
}

type UsbLike = { vendorId: number; productId: number; opened?: boolean; open(): Promise<void>; close(): Promise<void> };
/** Windows: could a device be opened once (WinUSB installed)? Asked once per device. */
const usbOpens = new WeakMap<object, boolean>();

async function lookForBoard(soc: string): Promise<MaskromStatus> {
  if (!navigator.usb) return { kind: 'none' };
  const list = ((await navigator.usb.getDevices()) as UsbLike[]).filter((d) => d.vendorId === ROCKCHIP_VID);
  const seen: SeenDevice[] = [];
  for (const d of list) {
    let opens: boolean | null = null;
    if (api.platform === 'win32') {
      if (!usbOpens.has(d)) {
        let ok = true;
        try { if (!d.opened) { await d.open(); await d.close(); } } catch { ok = false; }
        usbOpens.set(d, ok);
      }
      opens = usbOpens.get(d) ?? null;
    }
    seen.push({ vendorId: d.vendorId, productId: d.productId, opens });
  }
  return maskromStatus(seen, soc);
}

/**
 * Is a board in Maskrom mode connected? From Maskrom Studio: asked through
 * WebUSB (main/usb.ts lets the app's pages see Rockchip devices) every
 * 1.5 s while it is shown and the window is visible, and at once when a
 * device comes or goes. On Windows a device seen for the first time is
 * opened once and closed again: if that fails, WinUSB is not installed for
 * it yet. Desktop only: a browser lists only devices the user picked.
 */
function MaskromLive({ board, soc }: { board: string; soc: string }) {
  const [status, setStatus] = useState<MaskromStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      lookForBoard(soc).then((s) => { if (alive) setStatus(s); }, () => {});
    };
    tick();
    const id = setInterval(tick, 1500);
    const usb = navigator.usb as unknown as EventTarget | undefined;
    usb?.addEventListener('connect', tick);
    usb?.addEventListener('disconnect', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      clearInterval(id);
      usb?.removeEventListener('connect', tick);
      usb?.removeEventListener('disconnect', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [soc]);
  if (!status) return null;
  const s = status;
  const chip = soc.toUpperCase();
  return (
    <Alert isInline id="maskrom-live" variant={s.kind === 'ready' ? 'success' : s.kind === 'none' ? 'info' : 'warning'}
      title={s.kind === 'ready' ? t('An {chip} board in Maskrom mode is connected', { chip })
        : s.kind === 'no-driver' ? t('A board in Maskrom mode is connected, but Windows has no WinUSB driver for it')
        : s.kind === 'other-soc' ? t('A Rockchip device that is not an {chip} in Maskrom mode is connected (USB ID {pid})', { chip, pid: s.pid })
        : s.kind === 'several' ? t('{n} Rockchip devices are connected; connect only the board you want to write', { n: s.count })
        : t('No board in Maskrom mode yet')}>
      {s.kind === 'ready' ? t('Every {chip} board answers with the same USB IDs, so check that it is the {board}.', { chip, board })
        : s.kind === 'no-driver' ? t('Install WinUSB with Zadig as below, then this turns green.')
        : s.kind === 'none' ? t('This updates by itself. You can also go on and connect the board later.') : null}
    </Alert>
  );
}

function DestinationStep(p: {
  boardName: string; boardId: string; image: CatalogImage | undefined;
  method: Method; setMethod: (m: Method) => void;
  drives: { targets: Target[]; hidden: HiddenDrive[] } | null; refreshDrives: () => void;
  device: string | null; setDevice: (d: string) => void;
  /** Linux desktop: the "Show internal disks" switch, null where there is none. */
  showInternal: boolean | null; setShowInternal: (v: boolean) => void;
  storage: StorageId | null; setStorage: (s: StorageId) => void;
  source: MaskromSource; setSource: (s: MaskromSource) => void;
  file: PreparedFile | null; pickFile: () => void; picking: boolean; fileError: string | null;
  /** A Rockchip update.img for the eMMC (desktop only). */
  updateFile: UpdateImageFile | null; pickUpdate: () => void;
  /** After a whole image, also zero the old backup GPT at the end of the storage. */
  clearGpt: boolean; setClearGpt: (v: boolean) => void;
  releaseFile: PreparedFile | null; pickRelease: () => void; checking: Checking | null;
  downloadRelease: () => void; proxyError: string | null;
  /** An image file from this computer that is no release image: SD card or USB drive only. */
  custom: boolean;
  /** Why the chosen file must not go to SPI NOR flash (maskrom/spi-check.ts). */
  spiProblem: string | null;
  /** Save as an image file: where, choosing it, and why it cannot go there. */
  saveTarget: SaveTarget | null; pickSave: () => void; savePicking: boolean; saveError: string | null;
}) {
  const mb = maskromBoard(p.boardId);
  // A file picker under the radio it belongs to, indented like the radio's description.
  const fileRow = (button: React.ReactNode, text: React.ReactNode) => (
    <Flex className="file-row" spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
      <FlexItem flex={{ default: 'flexNone' }}>{button}</FlexItem>
      <FlexItem>{text}</FlexItem>
    </Flex>
  );
  // Web: a release file comes through the download proxy when the build has
  // one. Without it, or when it fails, the user downloads the file and
  // picks it (the alert under the title says how); either way it is
  // checked against the release, with a progress bar while that runs.
  const releaseKind = WEB && mb && (p.source === 'spi' ? 'spi' : p.source === 'release' ? 'image' : null);
  const relFile = releaseKind === 'spi' ? p.image?.spi : releaseKind === 'image' ? p.image : undefined;
  // An image a release carries in parts (larger than GitHub takes as one
  // file): the page cannot join them, so the user does and picks the result.
  const relParts = releaseKind === 'image' ? p.image?.parts ?? [] : [];
  const viaProxy = WEB && !!api.downloadProxy && !p.proxyError && relParts.length === 0;
  const releasePicker = (what: 'image' | 'spi') => {
    if (releaseKind !== what) return undefined;
    if (p.checking) {
      return (
        <Progress size="sm" title={p.checking.label} measureLocation={ProgressMeasureLocation.top}
          value={p.checking.total ? Math.floor(p.checking.done * 100 / p.checking.total) : 0}
          label={p.checking.total ? t('{done} of {total}', { done: formatBytes(p.checking.done), total: formatBytes(p.checking.total) }) : undefined} />
      );
    }
    if (viaProxy) {
      return fileRow(
        <Button variant="secondary" onClick={p.downloadRelease}>{t('Download from the release')}</Button>,
        p.releaseFile ? t('{name}: downloaded, matches the release', { name: p.releaseFile.name })
          : relFile ? t('{name}, {size}, through {proxy}', { name: relFile.file, size: formatBytes(relFile.size), proxy: api.downloadProxy ?? '' }) : '',
      );
    }
    return fileRow(
      <Button variant="secondary" onClick={p.pickRelease}>{t('Choose the downloaded file')}</Button>,
      p.releaseFile ? t('{name}: matches the release', { name: p.releaseFile.name }) : t('No file chosen'),
    );
  };
  // When the proxy download fails the reason is up under the title: bring it into view.
  const byHandRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (p.proxyError) byHandRef.current?.scrollIntoView({ block: 'nearest' }); }, [p.proxyError]);
  const byHand = !!relFile && !viaProxy && !p.releaseFile && (
    <Alert ref={byHandRef} isInline variant={p.proxyError ? 'warning' : 'info'} title={t('Download the release file by hand')}>
      {relParts.length > 0 ? (
        <>
          {t('This image is larger than GitHub takes as one file, so the release has it in {n} parts. Download them, join them in order', { n: relParts.length })}{' '}
          (<code>cat {relFile.file}.part* &gt; {relFile.file}</code>){t(', then choose the joined file under What to write:')}{' '}
          {relParts.map((part, i) => (
            <span key={part.file}>{i > 0 ? ', ' : ''}<Button variant="link" isInline component="a" href={part.url}>{part.file}</Button></span>
          ))}
        </>
      ) : (
        <>
          {p.proxyError ? msg(p.proxyError) : t('GitHub does not let a web page download release files itself.')}{' '}{t('Download it, then choose it under What to write:')}{' '}
          <Button variant="link" isInline component="a" href={relFile.url}>{relFile.file}</Button>
        </>
      )}
    </Alert>
  );
  const lead = WEB ? (
    <>
      {t('A browser cannot write an SD card or USB drive in this computer; for that use the')}{' '}
      <Button variant="link" isInline component="a" href={DESKTOP_URL} target="_blank">{t('Roxora Imager desktop app')}</Button>{' '}{t('or')}{' '}
      <Button variant="link" isInline component="a" href={RPI_IMAGER_URL} target="_blank">Raspberry Pi Imager</Button>{t('.')}
      {' '}{mb ? `${t('Here the {board} is written over USB in Maskrom mode.', { board: p.boardName })} ${loaderNote()}` : t('Maskrom writing is not set up for {board}.', { board: p.boardName })}
    </>
  ) : undefined;
  return (
    <StepPage title={t('Destination')} lead={lead} notices={byHand || undefined}>
      <Form className="destination" onSubmit={(e) => e.preventDefault()}>
        {!WEB && (
          <FormGroup role="radiogroup" fieldId="method" label={t('Write to')} isStack>
            <Radio id="method-sd" name="method" isChecked={p.method === 'sd'} onChange={() => p.setMethod('sd')}
              label={t('SD card or USB drive')} description={t('Write the image to a card or stick in this computer, then boot the board from it.')} />
            <Radio id="method-maskrom" name="method" isChecked={p.method === 'maskrom'} onChange={() => p.setMethod('maskrom')}
              isDisabled={!mb || p.custom}
              label={t('Board storage over USB (Maskrom)')}
              description={p.custom ? t('Not for the image file chosen in the Image step. Choose a board and one of its release images to write over USB; a file can be chosen there as well.')
                : mb ? `${t("Through the board's USB-C port: {storages}.", { storages: mb.storages.map((s) => t(STORAGES[s].label)).join(t(', or ')) })} ${loaderNote()}`
                : t('Maskrom writing is not set up for {board}.', { board: p.boardName })} />
            {api.pickSaveFile && (
              <Radio id="method-file" name="method" isChecked={p.method === 'file'} onChange={() => p.setMethod('file')}
                label={t('Save as an image file')}
                description={`${t('The uncompressed .img, for Ventoy and similar boot-from-file devices, or a virtual machine.')} ${bootNote(p.image, p.custom)}`}
                body={p.method === 'file' ? (
                  <Stack hasGutter>
                    {fileRow(
                      <Button variant="secondary" onClick={p.pickSave} isLoading={p.savePicking} isDisabled={p.savePicking}>{t('Choose where to save')}</Button>,
                      p.saveTarget ? p.saveTarget.path : t('No place chosen'),
                    )}
                    {p.saveError && <Alert variant="danger" isInline isPlain title={msg(p.saveError)} />}
                  </Stack>
                ) : undefined} />
            )}
          </FormGroup>
        )}

        {p.method === 'sd' && (
          <FormGroup fieldId="drives" label={t('Drive')}
            labelInfo={(
              <Flex className="drive-actions" spaceItems={{ default: 'spaceItemsLg' }} alignItems={{ default: 'alignItemsCenter' }}
                justifyContent={{ default: 'justifyContentFlexEnd' }} flexWrap={{ default: 'nowrap' }}>
                {p.showInternal !== null && (
                  <FlexItem>
                    <Switch id="show-internal" className="show-internal" label={t('Show internal disks')} isChecked={p.showInternal}
                      onChange={(_e, v) => p.setShowInternal(v)} aria-describedby="show-internal-note" />
                  </FlexItem>
                )}
                <FlexItem><Button variant="link" isInline onClick={() => p.refreshDrives()}>{t('Refresh')}</Button></FlexItem>
              </Flex>
            )}>
            {p.showInternal && (
              <div id="show-internal-note" className="muted">
                {t("Built-in disks (a board's eMMC, SD card slot or NVMe drive) are listed after the removable drives, only when nothing on them is mounted or in use. The disk the system runs from never is.")}
              </div>
            )}
            {!p.drives ? <Spinner size="md" aria-label={t('Looking for drives')} /> : p.drives.targets.length === 0 ? (
              <Content component="p">{t('No SD card or USB drive found. Insert one and click Refresh.')}</Content>
            ) : (
              <Table aria-label={t('Drives')} variant="compact" id="drives">
                <Thead><Tr><Th screenReaderText={t('Select')} /><Th>{t('Drive')}</Th><Th>{t('Device')}</Th><Th modifier="nowrap">{t('Size')}</Th></Tr></Thead>
                <Tbody>
                  {p.drives.targets.map((d, i) => (
                    <Tr key={d.device} isClickable={!d.disabled} onRowClick={() => !d.disabled && p.setDevice(d.device)} isRowSelected={p.device === d.device}>
                      <Td select={{ rowIndex: i, variant: 'radio', isSelected: p.device === d.device, isDisabled: !!d.disabled, onSelect: () => p.setDevice(d.device) }} />
                      <Td dataLabel={t('Drive')}>
                        {d.internal ? `${t(INTERNAL_WORDS[d.internal])}${d.description ? `: ${d.description}` : ''}` : d.description}
                        {d.disabled && <div className="muted">{msg(d.disabled)}</div>}
                        {d.warning && !d.disabled && <div className="muted">{msg(d.warning)}</div>}
                      </Td>
                      <Td dataLabel={t('Device')}>{d.device}</Td>
                      <Td dataLabel={t('Size')} modifier="nowrap">{formatBytes(d.size)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
            {p.drives && p.drives.hidden.length > 0 && (
              <ExpandableSection toggleText={t(p.drives.hidden.length === 1 ? '{n} drive is not offered' : '{n} drives are not offered', { n: p.drives.hidden.length })}>
                <Content component="ul">{p.drives.hidden.map((h) => <li key={h.device}>{h.device} {h.description}: {msg(h.reason)}</li>)}</Content>
              </ExpandableSection>
            )}
          </FormGroup>
        )}

        {p.method === 'maskrom' && mb && (
          <>
            <FormGroup role="radiogroup" fieldId="storage" label={t('Storage')} isStack>
              {mb.storages.map((s) => (
                <Radio key={s} id={`storage-${s}`} name="storage" isChecked={p.storage === s} onChange={() => p.setStorage(s)}
                  label={t(STORAGES[s].label)} description={t(STORAGES[s].note)} />
              ))}
            </FormGroup>
            <FormGroup role="radiogroup" fieldId="source" label={t('What to write')} isStack>
              <Radio id="src-release" name="source" isChecked={p.source === 'release'} onChange={() => p.setSource('release')}
                isDisabled={!p.storage || !mb.wholeImage.includes(p.storage)}
                label={p.image ? t('The image chosen in the previous step ({file})', { file: p.image.file }) : t('The image chosen in the previous step')}
                description={p.storage && mb.wholeImage.includes(p.storage) ? undefined
                  : mb.imageNote ? t(mb.imageNote) : t('A whole image goes to {storages}.', { storages: mb.wholeImage.map((s) => t(STORAGES[s].label)).join(t(' or ')) })}
                body={releasePicker('image')} />
              {mb.storages.includes('spinor') && (
                <Radio id="src-spi" name="source" isChecked={p.source === 'spi'} onChange={() => p.setSource('spi')}
                  isDisabled={!p.image?.spi || p.storage !== 'spinor'}
                  label={p.image?.spi ? t("This release's SPI bootloader ({file}, {size})", { file: p.image.spi.file, size: formatBytes(p.image.spi.size) }) : t("This release's SPI bootloader")}
                  description={!p.image?.spi ? t('This release has no SPI bootloader for the board.')
                    : viaProxy ? t('Downloaded from the release and checked against its SHA-256, then read back after writing.')
                    : WEB ? t('Checked against the release SHA-256 when you choose it, then read back after writing.')
                      : t('Downloaded from the release and checked against its SHA-256, then read back after writing.')}
                  body={releasePicker('spi')} />
              )}
              <Radio id="src-file" name="source" isChecked={p.source === 'file'} onChange={() => p.setSource('file')}
                label={t('A file on this computer')}
                description={p.storage === 'spinor' ? t('A bootloader file (.img, .bin, or compressed with xz, gzip or bzip2), no larger than the SPI NOR flash. It is written from the first sector.')
                  : t('An image or bootloader file (.img, .bin, or compressed with xz, gzip or bzip2). It is written from the first sector.')}
                body={p.source === 'file' ? fileRow(
                  <Button variant="secondary" onClick={p.pickFile} isLoading={p.picking} isDisabled={p.picking}>{t('Choose file')}</Button>,
                  p.file ? `${p.file.name}, ${formatBytes(p.file.size)}` : t('No file chosen'),
                ) : undefined} />
              {api.pickUpdateImage && mb.storages.includes('emmc') && (
                <Radio id="src-update" name="source" isChecked={p.source === 'update'} onChange={() => p.setSource('update')}
                  isDisabled={p.storage !== 'emmc'}
                  label={t("A Rockchip update.img (a vendor's factory firmware package)")}
                  description={p.storage !== 'emmc' ? t('For the eMMC only.')
                    : t("Written as RKDevTool's Upgrade Firmware does: the partition table from its parameter.txt, its loader, then each partition where parameter.txt puts it. Refused for another chip. Not yet tried on a board.")}
                  body={p.source === 'update' ? (
                    <Stack hasGutter>
                      {fileRow(
                        <Button variant="secondary" onClick={p.pickUpdate} isLoading={p.picking} isDisabled={p.picking}>{t('Choose update.img')}</Button>,
                        p.updateFile ? `${p.updateFile.name}, ${formatBytes(p.updateFile.size)}` : t('No file chosen'),
                      )}
                      {p.updateFile && <Content component="p" className="detail">{updateWords(p.updateFile)}</Content>}
                    </Stack>
                  ) : undefined} />
              )}
              {(p.source === 'release' || p.source === 'file') && (p.storage === 'emmc' || p.storage === 'sd') && (
                <Checkbox id="clear-gpt" isChecked={p.clearGpt} onChange={(_e, v) => p.setClearGpt(v)}
                  label={t('Also clear the old backup partition table at the end of the storage')}
                  description={t('A GPT keeps a copy of itself in the last 33 sectors. An image smaller than the storage leaves the old copy there, and some tools then report a damaged or stale partition table. With this ticked those sectors are zeroed after the image is written; they are not read back.')} />
              )}
              {p.fileError && <Alert variant="danger" isInline isPlain title={msg(p.fileError)} />}
              {p.spiProblem && <Alert variant="danger" isInline isPlain title={msg(p.spiProblem)} />}
            </FormGroup>
            <FormGroup fieldId="connect" label={t('Connect the board in Maskrom mode')}>
              <Stack hasGutter>
                {!WEB && <MaskromLive board={p.boardName} soc={mb.soc} />}
                <Content id="connect">
                  <ConnectSteps />
                  <DriversNote />
                </Content>
              </Stack>
            </FormGroup>
          </>
        )}
      </Form>
    </StepPage>
  );
}

function ReviewFooter({ canWrite, why, onWrite, save }: { canWrite: boolean; why: string | null; onWrite: () => void; save: boolean }) {
  const { goToPrevStep } = useWizardContext();
  return (
    <WizardFooterWrapper>
      {/* As anaconda's footer: helper text above the buttons. */}
      <Stack hasGutter>
        {why && <Content component="p" className="footer-note">{why}</Content>}
        <ActionList>
          <ActionListGroup>
            <ActionListItem><Button variant="secondary" onClick={goToPrevStep}>{t('Back')}</Button></ActionListItem>
            <ActionListItem>
              {/* A save erases nothing: the save dialog already asked before replacing a file. */}
              {save ? <Button variant="primary" onClick={onWrite} isDisabled={!canWrite}>{t('Save')}</Button>
                : <Button variant="danger" onClick={onWrite} isDisabled={!canWrite}>{t('Erase and write')}</Button>}
            </ActionListItem>
          </ActionListGroup>
        </ActionList>
      </Stack>
    </WizardFooterWrapper>
  );
}

/* The write itself replaces the wizard, as the installer's progress page does. */
function RunView({ run, onCancel, onDone, onRetry, onBack, facts, reconnect }: {
  run: Run; onCancel: () => void; onDone: () => void; onRetry: () => void; onBack: () => void;
  /** What Report a problem and Save full log get (shared/report.ts). */
  facts: () => ProblemFacts; reconnect: boolean;
}) {
  const working = run.kind === 'file' ? t('Saving') : t('Writing');
  const [savedLog, setSavedLog] = useState<string | null>(null);
  // Try again starts a new run in the same view: forget the last saved log.
  useEffect(() => { setSavedLog(null); }, [run.result]);
  const saveLog = () => {
    api.saveLog?.(facts()).then((r) => { if (r) setSavedLog('path' in r ? t('Log saved to {path}. Attach it to the issue.', { path: r.path }) : msg(r.error)); }, () => {});
  };
  return (
    <PageSection isFilled aria-label={working}>
      <Stack hasGutter className="step">
        <Title headingLevel="h2">{run.result ? (run.result.ok ? t('Done') : t('Stopped')) : working}</Title>
        {/* Twice the space between stages as between a stage's title and its bar. */}
        <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsXl' }}>
          {run.stages.map((s) => (
            <FlexItem key={s.id}>
              <Progress
                title={s.label + (s.detail ? `: ${s.detail}` : '')}
                value={s.percent ?? 0}
                // A stage with no percentage (the loader) says so in words.
                {...(s.percent === null ? { label: s.done ?? t('Waiting'), valueText: s.done ?? t('Waiting') } : {})}
                measureLocation={ProgressMeasureLocation.top}
                aria-label={s.label}
              />
            </FlexItem>
          ))}
        </Flex>
        {reconnect && !run.result && (
          <Alert isInline variant="info" title={t('Choose the board again')}
            actionLinks={<Button variant="secondary" onClick={() => { navigator.usb.requestDevice({ filters: [{ vendorId: 0x2207 }] }).catch(() => {}); }}>{t('Choose the board')}</Button>}>
            {t('The board restarted with the loader. The browser needs you to pick it once more.')}
          </Alert>
        )}
        {run.result && (
          <Alert isInline variant={run.result.ok ? (run.result.warning ? 'warning' : 'success') : 'danger'} title={run.result.title}>
            {run.result.text && <p>{run.result.text}</p>}
            {run.result.detail && <p className="detail">{run.result.detail}</p>}
          </Alert>
        )}
        {run.backup && (
          <Content component="p" id="spi-backup" className="selectable">
            {t('Before writing, the SPI NOR flash was copied to {path} ({file}). To put it back, write that file to the SPI NOR flash with A file on this computer.', { path: run.backup, file: 'spi-nor-before.bin' })}
          </Content>
        )}
        {run.result?.gone && run.board && (
          <Stack hasGutter id="board-gone">
            <Title headingLevel="h3">{t('Put the board back into Maskrom mode')}</Title>
            <Content component="p">{t('The USB connection to the board ended during the write (the cable was pulled, a plug is loose, or the board restarted).')}</Content>
            {!WEB && <MaskromLive board={run.board.name} soc={run.board.soc} />}
            <Content><ConnectSteps /></Content>
            <Content component="p">{t('Then press Try again: your choices are kept, the board is found again, the loader is sent again and the write starts over. Files already downloaded are not downloaded again.')}</Content>
          </Stack>
        )}
        <StackItem>
          {!run.result ? <Button variant="secondary" onClick={onCancel}>{t('Cancel')}</Button> : run.result.ok ? (
            <ActionList>
              <ActionListGroup>
                <ActionListItem><Button variant="primary" onClick={onDone}>{run.kind === 'file' ? t('Start over') : t('Write another')}</Button></ActionListItem>
                {run.saved && api.showSavedFile && (
                  <ActionListItem><Button variant="secondary" onClick={() => api.showSavedFile!(run.saved!)}>{t('Show in folder')}</Button></ActionListItem>
                )}
              </ActionListGroup>
            </ActionList>
          ) : (
            <Stack hasGutter>
              <ActionList>
                <ActionListGroup>
                  <ActionListItem><Button variant="primary" id="try-again" onClick={onRetry}>{t('Try again')}</Button></ActionListItem>
                  <ActionListItem><Button variant="secondary" id="back-to-steps" onClick={onBack}>{t('Back to the steps')}</Button></ActionListItem>
                </ActionListGroup>
                {api.reportProblem && (
                  <ActionListGroup>
                    <ActionListItem><Button variant="link" id="report-problem" onClick={() => { api.reportProblem!(facts()).catch(() => {}); }}>{t('Report a problem')}</Button></ActionListItem>
                    {api.saveLog && run.log.length > 0 && (
                      <ActionListItem><Button variant="link" id="save-log" onClick={saveLog}>{t('Save full log')}</Button></ActionListItem>
                    )}
                  </ActionListGroup>
                )}
              </ActionList>
              {api.reportProblem && (
                <Content component="p" className="muted">
                  {t('Report a problem opens a new issue on GitHub in your browser, filled in with the version, your system, the board, the error and the end of the log, without your user name, home folder, e-mail or IP addresses. Nothing is sent until you send it there.')}
                </Content>
              )}
              {savedLog && <Content component="p" className="selectable">{savedLog}</Content>}
            </Stack>
          )}
        </StackItem>
        {run.log.length > 0 && (
          <ExpandableSection toggleText={t('rkdeveloptool output')} className="log">
            <CodeBlock><CodeBlockCode>{run.log.slice(-400).join('\n')}</CodeBlockCode></CodeBlock>
          </ExpandableSection>
        )}
      </Stack>
    </PageSection>
  );
}

/** Copy text: through the main process in the desktop app (the page has no clipboard permission), else the browser's clipboard. */
function copyText(text: string): void {
  if (api.copyText) api.copyText(text).catch(() => {});
  else navigator.clipboard?.writeText(text).catch(() => {});
}

/**
 * Commands in a code block with a Copy button. The button itself says
 * "Copied" for a moment: feedback that does not depend on a tooltip.
 */
function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  const actions = (
    <CodeBlockAction>
      <Button variant="link" className="copy-button" aria-live="polite" onClick={() => { copyText(text); setCopied(true); }}>
        {copied ? t('Copied') : t('Copy')}
      </Button>
    </CodeBlockAction>
  );
  return <CodeBlock actions={actions}><CodeBlockCode>{text}</CodeBlockCode></CodeBlock>;
}

/** What pressing Update will do, by how this copy was installed. Shown before anything is downloaded. */
function updatePlan(o: UpdateOffer): string {
  const file = o.asset ? `${o.asset.name} (${formatBytes(o.asset.size)})` : '';
  switch (o.kind) {
    case 'brew': return t('This copy was installed with Homebrew. Roxora Imager runs Homebrew for you: "brew update", then "{command}". You then restart the app.', { command: brewCommand(o.ci ? 'roxora-imager@nightly' : undefined) });
    case 'dmg': return t('Roxora Imager downloads {file} to your Downloads folder, checks it against the SHA-256 GitHub lists for it, and puts the new app in place of this one. You then restart the app.', { file });
    case 'windows': return t('Roxora Imager downloads the installer {file}, checks it against the SHA-256 GitHub lists for it, then closes and starts the installer.', { file });
    case 'appimage': return t('Roxora Imager downloads {file}, checks it against the SHA-256 GitHub lists for it, and puts it in place of the AppImage you are running. You then restart the app.', { file });
    case 'deb': case 'rpm': return t("Roxora Imager downloads {file}, checks it against the SHA-256 GitHub lists for it, and installs it with the system's package manager, which asks for your password. You then restart the app.", { file });
    default: return '';
  }
}

/* The update itself: nothing is downloaded before the button in here is pressed. */
function UpdateModal({ offer, onClose }: { offer: UpdateOffer | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ bytes: number; total: number } | null>(null);
  const [stage, setStage] = useState('download');
  const [log, setLog] = useState('');
  const [result, setResult] = useState<UpdateResult | null>(null);
  useEffect(() => { setResult(null); setProgress(null); setLog(''); }, [offer?.version]);
  if (!offer) return null;
  const brew = offer.kind === 'brew';
  const apt = offer.kind === 'apt';
  const canInstall = !!api.installUpdate && !apt && (brew || (!!offer.asset && offer.kind !== 'none'));
  const start = async () => {
    setBusy(true);
    setResult(null);
    setLog('');
    setStage(brew ? 'brew-update' : 'download');
    setProgress({ bytes: 0, total: offer.asset?.size ?? 0 });
    const offs = [
      api.onUpdateProgress?.(setProgress), api.onUpdateStage?.(setStage),
      api.onUpdateLog?.((t) => setLog((cur) => (cur + t).slice(-20000))),
    ];
    const r = await api.installUpdate!();
    offs.forEach((off) => off?.());
    setBusy(false);
    setResult(r);
  };
  const close = () => { if (!busy) onClose(); };
  const notes = <Button variant="link" isInline component="a" href={offer.url} target="_blank">{t('Release notes')}</Button>;
  // Once the app itself is being replaced there is no stopping half way.
  const canCancel = stage === 'download' || stage === 'brew-update';
  const working: Record<string, string> = {
    'brew-update': t('Homebrew is looking for the new version'),
    'brew-upgrade': t('Homebrew is installing the new version. Do not quit Roxora Imager.'),
    install: t('Putting the new app in place. Do not quit Roxora Imager.'),
  };
  return (
    <Modal isOpen onClose={close} variant="small" aria-labelledby="update-title">
      <ModalHeader title={t('Update to Roxora Imager {version}', { version: offerName(offer) })} labelId="update-title" />
      <ModalBody>
        <Stack hasGutter>
          {brew && !canInstall && (
            <>
              <Content component="p">{t('This copy was installed with Homebrew. Update it in Terminal with:')}</Content>
              <CopyBlock text={brewCommand(offer.ci ? 'roxora-imager@nightly' : undefined)} />
            </>
          )}
          {apt && (
            <>
              <Content component="p">
                {t("This copy was installed from a package repository, and the system's software updates keep it up to date. Roxora Imager {version} comes with them once the repository has it. To update now, in a terminal:", { version: offer.version })}
              </Content>
              <CopyBlock text={APT_COMMAND} />
            </>
          )}
          {!brew && !apt && !canInstall && (
            <Content component="p">
              {t(offer.kind === 'none' ? 'The app cannot update this copy itself. Get the new version from the release page.'
                : 'The app cannot update this copy itself: the release has no package for this computer. Get the new version from the release page.')}
            </Content>
          )}
          {canInstall && !busy && !result && <Content component="p">{updatePlan(offer)}</Content>}
          {busy && stage === 'download' && progress && (
            <Progress title={t('Downloading {name}', { name: offer.asset?.name ?? '' })} measureLocation={ProgressMeasureLocation.top}
              value={progress.total ? Math.min(100, Math.floor(progress.bytes * 100 / progress.total)) : 0}
              label={t('{done} of {total}', { done: formatBytes(progress.bytes), total: formatBytes(progress.total) })} />
          )}
          {busy && stage !== 'download' && (
            <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }} flexWrap={{ default: 'nowrap' }}>
              <FlexItem flex={{ default: 'flexNone' }}><Spinner size="md" aria-label={t('Working')} /></FlexItem>
              <FlexItem>{working[stage] ?? t('Installing')}</FlexItem>
            </Flex>
          )}
          {result && (
            <Alert isInline variant={result.ok ? 'success' : 'danger'} title={msg(result.ok ? result.message : result.reason)} />
          )}
          {result && !result.ok && result.command && <CopyBlock text={result.command} />}
          {log && (
            <ExpandableSection toggleText={t('Output')} className="log">
              <CodeBlock><CodeBlockCode>{log}</CodeBlockCode></CodeBlock>
            </ExpandableSection>
          )}
          <StackItem>{notes}</StackItem>
        </Stack>
      </ModalBody>
      <ModalFooter>
        {canInstall && !busy && !result && <Button variant="primary" onClick={start}>{brew ? t('Update with Homebrew') : t('Download and install')}</Button>}
        {busy && canCancel && <Button variant="secondary" onClick={() => api.cancelUpdate?.()}>{t('Cancel')}</Button>}
        {result?.ok && result.restart && <Button variant="primary" onClick={() => api.restartApp?.()}>{t('Restart now')}</Button>}
        {result && !result.ok && canInstall && <Button variant="secondary" onClick={start}>{t('Try again')}</Button>}
        {!busy && <Button variant="link" onClick={close}>{result?.ok && result.restart ? t('Later') : result || !canInstall ? t('Close') : t('Cancel')}</Button>}
      </ModalFooter>
    </Modal>
  );
}

/** The answer to "Check now", in a sentence. */
function checkWords(c: UpdateCheck): string {
  if (c.state === 'error') return msg(c.message);
  if (c.state === 'newer') return t('Roxora Imager {version} is available.', { version: offerName(c.offer) });
  if (c.ci) return t('You have the newest CI build ({version}), or there is none yet.', { version: c.version });
  const beta = c.newerBeta ? t(' A newer beta, {version}, is out; choose Prerelease to be offered it.', { version: c.newerBeta }) : '';
  return (c.beta ? t('You have {version}, a beta version. There is no newer normal release yet.', { version: c.version })
    : t('You have the newest version ({version}).', { version: c.version })) + beta;
}

/** "0.1.11", "0.1.12-beta.1 (beta)", or "CI build 1a2b3c4 (untested)". */
function offerName(o: UpdateOffer): string {
  return `${o.ci ? t('CI build {commit}', { commit: o.version.replace(/^CI build /, '') }) : o.version}${o.ci ? t(' (untested)') : o.beta ? t(' (beta)') : ''}`;
}

const TIER_NAMES: Record<Channel, string> = { stable: 'Stable', prerelease: 'Prerelease', ci: 'CI' };
const TIER_HELP: Record<Channel, string> = {
  stable: 'Normal releases only.',
  prerelease: 'Betas too (pre-releases on GitHub), before they become a normal release.',
  ci: 'The latest build of main from the Release workflow: untested, replaced on every successful build.',
};

type AppSettings = { updateCheck: boolean; appChannel?: Channel; resetAfterMaskrom: boolean };

function SettingsModal({ open, onClose, theme, setTheme, onOffer, onUpdate, writing, onAbout }: {
  open: boolean; onClose: () => void; theme: Theme; setTheme: (t: Theme) => void;
  /** Open About Roxora Imager. */
  onAbout: () => void;
  /** A check found a newer version. */
  onOffer: (o: UpdateOffer) => void;
  /** The user wants it. */
  onUpdate: () => void;
  writing: boolean;
}) {
  const { lang, setLang } = useI18n();
  const [s, setS] = useState<AppSettings | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [cache, setCache] = useState<CacheInfo | null>(null);
  const [clearAsk, setClearAsk] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    api.getSettings().then(setS);
    setCheck(null);
    setCleared(null);
    api.cacheInfo?.().then(setCache);
  }, [open]);
  const cacheBytes = cache ? cache.images.bytes + cache.loaders.bytes : 0;
  const doClear = async () => {
    const r = await api.clearCache!();
    setClearAsk(false);
    setCleared(r.ok ? t('Cleared: {size} freed.', { size: formatBytes(r.freed) }) : msg(r.reason));
    api.cacheInfo?.().then(setCache);
  };
  const set = (patch: Partial<AppSettings>) => {
    setS((cur) => (cur ? { ...cur, ...patch } : cur));
    return api.setSettings(patch);
  };
  const checkNow = async () => {
    setChecking(true);
    const r = await api.checkUpdate(true);
    setChecking(false);
    setCheck(r);
    if (r?.state === 'newer') onOffer(r.offer);
  };
  return (
    <>
    <Modal isOpen={open} onClose={onClose} variant="small" aria-labelledby="settings-title">
      <ModalHeader title={t('Settings')} labelId="settings-title" />
      <ModalBody>
        {s && (
          <Form onSubmit={(e) => e.preventDefault()}>
            {!WEB && (
              <FormSection title={t('Updates')} titleElement="h3">
                <FormGroup fieldId="set-update" label={t('Automatic check')} hasNoPaddingTop>
                  <Switch id="set-update" label={t('Check for a new version once a day')} isChecked={s.updateCheck}
                    onChange={(_e, v) => { set({ updateCheck: v }); }} />
                </FormGroup>
                <FormGroup fieldId="app-channel" label={t('Release tier')} role="group">
                  <ToggleGroup aria-label={t('Release tier')} id="app-channel">
                    {CHANNELS.map((c) => (
                      <ToggleGroupItem key={c} text={t(TIER_NAMES[c])} buttonId={`tier-${c}`} isSelected={(s.appChannel ?? 'stable') === c}
                        onChange={() => { set({ appChannel: c }).then(checkNow); }} />
                    ))}
                  </ToggleGroup>
                  <FormHelperText><HelperText><HelperTextItem variant={(s.appChannel ?? 'stable') === 'stable' ? 'default' : 'warning'}>
                    {t(TIER_HELP[s.appChannel ?? 'stable'])}
                  </HelperTextItem></HelperText></FormHelperText>
                </FormGroup>
                <FormGroup fieldId="check-now">
                  <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
                    <FlexItem flex={{ default: 'flexNone' }}>
                      <Button id="check-now" variant="secondary" onClick={checkNow} isLoading={checking} isDisabled={checking}>{t('Check now')}</Button>
                    </FlexItem>
                    {check && <FlexItem className="update-result" aria-live="polite">{checkWords(check)}</FlexItem>}
                    {check?.state === 'newer' && (
                      <FlexItem><Button variant="link" isInline isDisabled={writing} onClick={onUpdate}>{t('Update')}</Button></FlexItem>
                    )}
                  </Flex>
                </FormGroup>
              </FormSection>
            )}
            <FormSection title="Maskrom" titleElement="h3">
              <FormGroup fieldId="set-reset" label={t('After writing')} hasNoPaddingTop>
                <Switch id="set-reset" label={t('Restart the board after a Maskrom write')} isChecked={s.resetAfterMaskrom}
                  onChange={(_e, v) => { set({ resetAfterMaskrom: v }); }} />
              </FormGroup>
            </FormSection>
            {api.cacheInfo && (
              <FormSection title={t('Downloads')} titleElement="h3">
                <FormGroup fieldId="clear-cache">
                  <Content component="p">{cache
                    ? t('{size} in downloaded images and Maskrom loaders (files: {files}), downloaded or built again when needed.', { size: formatBytes(cacheBytes), files: cache.images.files + cache.loaders.files })
                    : t('Measuring the downloads.')}</Content>
                  <Flex><FlexItem>
                    <Button id="clear-cache" variant="secondary" isDisabled={writing || !cache || cacheBytes === 0} onClick={() => setClearAsk(true)}>{t('Clear cache')}</Button>
                  </FlexItem></Flex>
                  {(writing || cleared) && (
                    <FormHelperText><HelperText><HelperTextItem>{writing ? t('Not while a write is running.') : cleared}</HelperTextItem></HelperText></FormHelperText>
                  )}
                </FormGroup>
              </FormSection>
            )}
            <FormSection title={t('Appearance')} titleElement="h3">
              <FormGroup fieldId="appearance" label={t('Theme')} role="group">
                <ToggleGroup aria-label={t('Theme')} id="appearance">
                  {(['system', 'light', 'dark'] as Theme[]).map((th) => (
                    <ToggleGroupItem key={th} text={t(th[0].toUpperCase() + th.slice(1))} isSelected={theme === th} onChange={() => setTheme(th)} />
                  ))}
                </ToggleGroup>
              </FormGroup>
              <FormGroup fieldId="language" label={t('Language')} role="group">
                <ToggleGroup aria-label={t('Language')} id="language">
                  {LANGS.map((l) => (
                    <ToggleGroupItem key={l} text={LANG_NAMES[l]} isSelected={lang === l} onChange={() => setLang(l)} />
                  ))}
                </ToggleGroup>
              </FormGroup>
            </FormSection>
            <FormSection title={t('Version')} titleElement="h3">
              <FormGroup fieldId="about-open">
                <Content component="p">{api.version}</Content>
                <Flex><FlexItem>
                  <Button id="about-open" variant="link" isInline onClick={onAbout}>{t('About Roxora Imager')}</Button>
                </FlexItem></Flex>
              </FormGroup>
            </FormSection>
          </Form>
        )}
      </ModalBody>
      <ModalFooter><Button variant="primary" onClick={onClose}>{t('Close')}</Button></ModalFooter>
    </Modal>
    {clearAsk && cache && (
      <Modal isOpen onClose={() => setClearAsk(false)} variant="small" aria-labelledby="clear-title">
        <ModalHeader title={t('Clear the cache?')} labelId="clear-title" />
        <ModalBody>
          <Stack hasGutter>
            <Content component="p">{t('These are deleted, from {dir}:', { dir: cache.images.dir.replace(/[\\/]images$/, '') })}</Content>
            {/* Only what is there: an empty kind is not listed. */}
            <List>
              {cache.images.files > 0 && (
                <ListItem>{t('Downloaded images: {size}, files: {files}', { size: formatBytes(cache.images.bytes), files: cache.images.files })}{cache.images.names.length ? ` (${cache.images.names.join(', ')})` : ''}</ListItem>
              )}
              {cache.loaders.files > 0 && (
                <ListItem>{t('Maskrom loaders built from rkbin: {size}, files: {files}', { size: formatBytes(cache.loaders.bytes), files: cache.loaders.files })}</ListItem>
              )}
            </List>
            <Content component="p">{t('The settings are kept.')}</Content>
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={doClear} isDisabled={cacheBytes === 0}>{t('Delete {size}', { size: formatBytes(cacheBytes) })}</Button>
          <Button variant="link" onClick={() => setClearAsk(false)}>{t('Cancel')}</Button>
        </ModalFooter>
      </Modal>
    )}
    </>
  );
}

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DATE__: string;
declare const __PATTERNFLY_VERSION__: string;
const BUILD = {
  commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown',
  date: typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '',
  patternfly: typeof __PATTERNFLY_VERSION__ === 'string' ? __PATTERNFLY_VERSION__ : '',
};

/**
 * About Roxora Imager: PatternFly's about modal box with the facts of this
 * build. Every row has to be true for the build that shows it.
 */
function AboutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const close = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);
  if (!open) return null;
  const link = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>;
  const rows: Array<[string, React.ReactNode]> = [
    [t('Version'), `${api.version} (${BUILD.commit}${BUILD.date ? `, ${BUILD.date}` : ''})`],
    [t('Design system'), BUILD.patternfly ? `PatternFly ${BUILD.patternfly}` : 'PatternFly'],
    ...(WEB ? [] : [
      [t('Network'), t("GitHub (the Roxora releases and this app's updates), and {host} once for Rockchip's rkbin. No analytics or telemetry.", { host: RKBIN_HOST })],
      [t('Kept on your device'), <>{t('Settings and downloads, in')} <span className="selectable">{api.dataDir}</span>{t('; Settings has Clear cache')}</>],
    ] as Array<[string, React.ReactNode]>),
    [t('Licence'), 'GPL-2.0-only'],
    [t('Source'), link('https://github.com/roxora-os/imager', 'github.com/roxora-os/imager')],
    ...(api.reportProblem ? [[t('Report a problem'),
      <Button variant="link" isInline id="about-report" onClick={() => { api.reportProblem!({}).catch(() => {}); }}>{t('Opens a new issue on GitHub with the version and your system filled in.')}</Button>]] as Array<[string, React.ReactNode]> : []),
  ];
  // On the document body, as PatternFly's Modal does, so the backdrop covers the masthead too.
  return createPortal(
    <div className="pf-v6-c-backdrop about-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pf-v6-l-bullseye">
        <div className="pf-v6-c-about-modal-box" role="dialog" aria-modal="true" aria-labelledby="about-title">
          <div className="pf-v6-c-about-modal-box__brand"><img src="resources/roxora-mark.svg" alt="" className="about-mark" /></div>
          <div className="pf-v6-c-about-modal-box__close">
            <Button ref={close} variant="plain" aria-label={t('Close About Roxora Imager')} icon={<TimesIcon />} onClick={onClose} />
          </div>
          <div className="pf-v6-c-about-modal-box__header">
            <h1 className="pf-v6-c-title pf-m-2xl" id="about-title">{t('About Roxora Imager')}</h1>
          </div>
          <div className="pf-v6-c-about-modal-box__content">
            <dl className="pf-v6-c-description-list pf-m-horizontal">
              {rows.map(([k, v]) => (
                <div className="pf-v6-c-description-list__group" key={k}>
                  <dt className="pf-v6-c-description-list__term"><span className="pf-v6-c-description-list__text">{k}</span></dt>
                  <dd className="pf-v6-c-description-list__description"><div className="pf-v6-c-description-list__text">{v}</div></dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function App() {
  // Re-render the page in another language when it is chosen.
  const { lang: pageLang } = useI18n();
  const [theme, setThemeState] = useState<Theme>(readTheme());
  const setTheme = (th: Theme) => { setThemeState(th); applyTheme(th); };
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [useSample, setUseSample] = useState(api.devSample);
  const [board, setBoard] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [vendor, setVendor] = useState('__all');
  const [imageId, setImageId] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>(WEB ? 'maskrom' : 'sd');
  const [drives, setDrives] = useState<{ targets: Target[]; hidden: HiddenDrive[] } | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageId | null>(null);
  const [source, setSource] = useState<MaskromSource>('release');
  const [file, setFile] = useState<PreparedFile | null>(null);
  const [picking, setPicking] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [updateFile, setUpdateFile] = useState<UpdateImageFile | null>(null);
  const [clearGpt, setClearGpt] = useState(false);
  const [releaseFile, setReleaseFile] = useState<PreparedFile | null>(null);
  const [checking, setChecking] = useState<Checking | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const [local, setLocal] = useState<LocalImage | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [jump, setJump] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  // Save as an image file: where (chosen in the save dialog).
  const [saveTarget, setSaveTarget] = useState<SaveTarget | null>(null);
  const [savePicking, setSavePicking] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Linux desktop only: built-in disks (linuxDiskFacts in shared/targets.ts).
  const internalSwitch = !WEB && api.platform === 'linux';
  const [showInternal, setShowInternal] = useState(false);
  // A built-in disk the user clicked, waiting for the extra confirmation.
  const [askInternal, setAskInternal] = useState<Target | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [settings, setSettings] = useState(false);
  const [about, setAbout] = useState(false);
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [updating, setUpdating] = useState(false);
  // Closing the notice hides that version for good; Settings still offers it.
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return localStorage.getItem('updateDismissed'); } catch { return null; } });
  const dismissUpdate = (v: string) => { setDismissed(v); try { localStorage.setItem('updateDismissed', v); } catch { /* no storage */ } };
  const [usbChoices, setUsbChoices] = useState<{ deviceId: string; productName?: string; productId: number }[] | null>(null);
  const maskromJob = useRef<MaskromJob | null>(null);

  const load = useCallback(() => {
    setCatalog(null);
    api.loadCatalog({ sample: useSample }).then(setCatalog);
  }, [useSample]);
  useEffect(load, [load]);
  // At start and then hourly: the main process checks at most once a day.
  useEffect(() => {
    const look = () => { api.checkUpdate(false).then((r) => { if (r?.state === 'newer') setOffer(r.offer); }); };
    look();
    const t = setInterval(look, 60 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => api.onUsbChoice(setUsbChoices), []);

  const boards = useMemo(() => (catalog?.state === 'ok' ? groupByBoard(catalog.images) : []), [catalog]);
  const cur = boards.find((b) => b.board === board);
  const image = cur?.images.find((i) => i.id === imageId);
  const mb = board ? maskromBoard(board) : undefined;
  const sample = catalog?.state === 'ok' && catalog.sample;
  // A file from this computer that no release vouches for.
  const custom = !!local && !local.imageId;

  const chooseBoard = (b: string) => {
    if (b === board) return;
    setBoard(b);
    const bb = boards.find((x) => x.board === b);
    setImageId(bb?.images[0]?.id ?? null);
    const m = maskromBoard(b);
    setStorage(m?.imageStorage ?? m?.storages[0] ?? null);
    setSource(defaultSource(m, bb?.images[0]));
  };

  // Another image of the same board may or may not carry an SPI bootloader.
  useEffect(() => {
    if (source === 'spi' && !image?.spi) setSource('file');
    else if (source === 'file' && !file && image?.spi && mb && !mb.imageStorage && storage === 'spinor') setSource('spi');
  }, [imageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const minSize = local && !local.imageId ? local.extractSize : image?.extractSize ?? 0;
  const refreshDrives = useCallback((internal: boolean = showInternal) => {
    setDrives(null);
    api.listDrives(minSize, internalSwitch && internal).then((d) => {
      setDrives(d);
      setDevice((cur) => (d.targets.some((t) => t.device === cur && !t.disabled) ? cur : null));
    });
  }, [minSize, showInternal, internalSwitch]);
  const toggleInternal = (v: boolean) => { setShowInternal(v); refreshDrives(v); };
  // A built-in disk is chosen only after a second question that names it.
  const chooseDevice = (d: string) => {
    const t = drives?.targets.find((x) => x.device === d);
    if (t?.internal && d !== device) setAskInternal(t); else setDevice(d);
  };

  // An image file on this computer for the SD/USB path. One that is a
  // release image selects that image; any other is a custom image.
  const acceptLocal = (r: LocalImage | { error: string } | null) => {
    if (!r) return;
    if ('error' in r) {
      setLocalError(r.error);
      // The message shows on the Board and Image steps.
      if (board || local) setJump('image');
      return;
    }
    setLocalError(null);
    setLocal(r);
    const img = r.imageId && catalog?.state === 'ok' ? catalog.images.find((i) => i.id === r.imageId) : undefined;
    if (img) {
      chooseBoard(img.board);
      setImageId(img.id);
    } else if (method === 'maskrom') {
      // Maskrom takes release images only; a custom file goes to a drive or a file.
      setMethod('sd');
    }
    setJump('image');
  };
  const pickLocal = async () => {
    if (!api.pickLocalImage || localBusy) return;
    setLocalBusy(true);
    const r = await api.pickLocalImage();
    setLocalBusy(false);
    acceptLocal(r);
  };
  const lp: LocalPick = { local, busy: localBusy, error: localError, pick: pickLocal, clear: () => { setLocal(null); setLocalError(null); } };
  // A file dropped anywhere on the window, while no write is running.
  const dropRef = useRef<(f: File) => void>(() => {});
  dropRef.current = async (f: File) => {
    if (!api.dropLocalImage || run || localBusy) return;
    setLocalBusy(true);
    const r = await api.dropLocalImage(f);
    setLocalBusy(false);
    acceptLocal(r);
  };
  useEffect(() => {
    if (!api.dropLocalImage) return undefined;
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      const f = e.dataTransfer?.files[0];
      if (!f) return;
      e.preventDefault();
      dropRef.current(f);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, []);

  const pickFile = async () => {
    setPicking(true);
    setFileError(null);
    if (file) api.releaseMaskrom(file.token);
    const r = await api.pickMaskromFile();
    setPicking(false);
    if (!r) return;
    if ('error' in r) { setFile(null); setFileError(r.error); return; }
    setFile(r);
  };

  const pickUpdate = async () => {
    if (!api.pickUpdateImage) return;
    setPicking(true);
    setFileError(null);
    if (updateFile) api.releaseMaskrom(updateFile.token);
    setUpdateFile(null);
    const r = await api.pickUpdateImage();
    setPicking(false);
    if (!r) return;
    if ('error' in r) { setFileError(r.error); return; }
    setUpdateFile(r);
  };

  const pickRelease = async () => {
    if (!image || !api.pickReleaseFile) return;
    setFileError(null);
    setChecking({ label: t('Checking the file against the release'), done: 0, total: 0 });
    const r = await api.pickReleaseFile(image.id, source === 'spi' ? 'spi' : 'image',
      (d, n) => setChecking({ label: t('Checking the file against the release'), done: d, total: n }));
    setChecking(null);
    if (!r) return;
    if ('error' in r) { setReleaseFile(null); setFileError(r.error); return; }
    setReleaseFile(r);
  };
  const downloadRelease = async () => {
    if (!image || !api.downloadReleaseFile) return;
    setFileError(null);
    setChecking({ label: t('Downloading and checking'), done: 0, total: 0 });
    const r = await api.downloadReleaseFile(image.id, source === 'spi' ? 'spi' : 'image',
      (d, n) => setChecking({ label: t('Downloading and checking'), done: d, total: n }));
    setChecking(null);
    if ('error' in r) { setReleaseFile(null); setProxyError(r.error); return; }
    setReleaseFile(r);
  };
  // A picked release file belongs to one image and one kind.
  useEffect(() => { setReleaseFile(null); setProxyError(null); }, [imageId, source]);

  // Save as an image file. The dialog offers the .img name of what is
  // saved, so another image means choosing again.
  const saveName = uncompressedName(local ? local.name : image?.file ?? 'roxora.img');
  useEffect(() => { setSaveTarget(null); setSaveError(null); }, [saveName]);
  // What the file will take: unknown before reading for a gzip or bzip2 custom image.
  const saveNeed = custom ? local!.extractSize : image?.extractSize ?? local?.extractSize ?? 0;
  const saveShort = !!saveTarget && saveTarget.free >= 0 && saveNeed > 0 && saveTarget.free < saveNeed
    ? t('There is not enough free space in {dir}: the image needs {need}, {free} is free. Choose another place.', { dir: saveTarget.dir, need: formatBytes(saveNeed), free: formatBytes(saveTarget.free) })
    : null;
  const pickSave = async () => {
    if (!api.pickSaveFile || savePicking) return;
    setSavePicking(true);
    setSaveError(null);
    const r = await api.pickSaveFile(saveName);
    setSavePicking(false);
    if (!r) return;
    if ('error' in r) { setSaveError(r.error); return; }
    setSaveTarget(r);
  };

  const target = drives?.targets.find((t) => t.device === device);
  const spiProblem = method === 'maskrom' && storage === 'spinor' && source === 'file' && file
    ? spiFileProblem(file, {
      flashSize: mb?.spiFlashSize ?? SPI_FLASH_FALLBACK,
      imageFiles: catalog?.state === 'ok' ? catalog.images.map((i) => i.file) : [],
      spiFile: image?.spi?.file ?? null,
    }) : null;
  const destReady = method === 'sd' ? !!target
    : method === 'file' ? !!saveTarget && !saveShort
    : !!storage && (source === 'update' ? !!updateFile && storage === 'emmc'
      : source === 'file' ? !!file && !spiProblem
      : source === 'spi' ? !!image?.spi && storage === 'spinor' && (!WEB || !!releaseFile)
        : !!image && !!mb?.wholeImage.includes(storage) && (!WEB || !!releaseFile));

  let why: string | null = null;
  if (sample && !custom) why = method === 'file' ? t('Sample data cannot be saved.') : t('Sample data cannot be written.');
  else if (!destReady) why = t('Choose a destination first.');

  const erasedWhat = method === 'file' ? '' : method === 'sd'
    ? (target ? `${target.internal ? t('the built-in {kind}, ', { kind: t(INTERNAL_WORDS[target.internal]) }) : ''}${target.description} (${target.device}, ${formatBytes(target.size)})` : '')
    : (storage && mb ? t('the {storage} ({board}, connected over USB)', { storage: t(STORAGES[storage].label), board: mb.boardName }) : '');
  const erased = erasedWhat ? t('Everything on {what}.', { what: erasedWhat }) : '';
  const saveChecks = custom
    ? t('Nothing is compared with a Roxora release; the SHA-256 of the saved image is shown when it is done. Until it is complete, it is a temporary file in the same folder, so a cancelled or failed save leaves nothing under the chosen name.')
    : `${local ? t('The file is checked against the release SHA-256 again.') : t('The download is checked against the release SHA-256.')} ${t('The decompressed image must have the size and SHA-256 the release gives. Until then it is a temporary file in the same folder, so a cancelled or failed save leaves nothing under the chosen name.')}`;

  /** The progress of a drive write or a save, on the run's stages. Returns the unsubscribe. */
  const followProgress = () => api.onProgress((p: JobProgress) => {
    const id = p.stage === 'check' || p.stage === 'download' ? 'download' : p.stage;
    const pct = p.total ? Math.min(100, Math.floor(p.bytes * 100 / p.total)) : null;
    // A save of a gzip or bzip2 image does not know its size: bytes so far instead.
    const done = pct === null && p.bytes > 0 ? t('{size} so far', { size: formatBytes(p.bytes) }) : undefined;
    // A stage that has started means the ones before it are done.
    setRun((cur) => cur && { ...cur, stages: cur.stages.map((s) => (s.id === id ? { ...s, percent: pct, done }
      : s.id === 'download' && id !== 'download' ? { ...s, percent: 100 } : s)) });
  });

  const startSave = async () => {
    const tgt = saveTarget;
    if (!tgt || !api.saveImage || (!local && !image)) return;
    const name = local ? local.name : image!.file;
    const what: SaveSubject = local ? { localToken: local.token } : { imageId: image!.id };
    setRun({
      kind: 'file', log: [], result: null, saved: tgt.token,
      stages: [
        ...(custom ? [] : [{ id: 'download', percent: 0, label: local ? t('Check the file against the release') : t('Download and check') }]),
        { id: 'write', percent: 0, label: t(uncompressedName(name) === name ? 'Save {file}' : 'Decompress and save {file}', { file: fileName(tgt.path) })
          + (custom ? '' : t(', and compare with the release')) },
      ],
    });
    const off = followProgress();
    // As in startSd: never leave a run without a result.
    let res: Awaited<ReturnType<NonNullable<typeof api.saveImage>>>;
    try {
      res = await api.saveImage(what, tgt.token);
    } catch (e) {
      res = { ok: false, reason: 'The save stopped with an error.', detail: String((e as Error)?.message ?? e) };
    } finally {
      off();
    }
    setRun((cur) => cur && {
      ...cur,
      // A bar that counted bytes without a total ends full.
      stages: res.ok ? cur.stages.map((s) => ({ ...s, percent: 100, done: undefined })) : cur.stages,
      result: res.ok
        // The SHA-256 on a line of its own, in the detail style: a path and a hash in one sentence wrap badly.
        ? { ok: true, title: custom ? t('Saved') : t('Saved and checked'), detail: `SHA-256 ${res.sha256}`, text: custom
          ? t('{path} holds {name}, decompressed. The file is not a Roxora release image and was not checked against one.', { path: tgt.path, name })
          : t('{path} holds {name}, decompressed. It matches the release.', { path: tgt.path, name }) }
        : { ok: false, title: msg(res.reason), text: /Nothing was saved/.test(res.reason) ? '' : t('Nothing was saved under that name.'), reason: res.reason,
          ...(res.detail ? { detail: res.detail } : {}) },
    });
  };

  const startSd = async () => {
    if (!target || (!local && !image)) return;
    const name = local ? local.name : image!.file;
    const r: Run = {
      kind: 'sd', log: [], result: null,
      stages: [
        { id: 'download', percent: 0, label: custom ? t('Read the image and take its SHA-256')
          : local ? t('Check the file against the release') : t('Download and check') },
        { id: 'write', label: t('Write {device}', { device: target.device }), percent: 0 },
        { id: 'verify', label: custom ? t('Read back and compare with the image') : t('Read back and compare with the release'), percent: 0 },
      ],
    };
    setRun(r);
    const off = followProgress();
    // A write that throws (an IPC call that failed) must still end the run:
    // a run without a result counts as a write in progress, which hides the
    // update notice and greys out Update until the app is restarted.
    let res: Awaited<ReturnType<typeof api.writeSd>>;
    try {
      res = local && api.writeLocalImage ? await api.writeLocalImage(local.token, target.device, !!target.internal)
        : await api.writeSd(image!.id, target.device, !!target.internal);
    } catch (e) {
      res = { ok: false, reason: 'The write stopped with an error.', detail: String((e as Error)?.message ?? e) } as typeof res;
    } finally {
      off();
    }
    setRun((cur) => cur && {
      ...cur,
      result: res.ok
        ? { ok: true, title: t('Written and verified'), text: custom
          ? t('{drive} holds {name}. The read-back matches the image file (SHA-256 {sha}). The file is not a Roxora release image and was not checked against one. You can remove the drive.', { drive: target.description, name, sha: res.sha256 })
          : t('{drive} holds {name}. The read-back matches the release (SHA-256 {sha}). You can remove the drive.', { drive: target.description, name, sha: res.sha256 }) }
        : { ok: false, title: msg(res.reason), text: /Nothing was written/.test(res.reason) ? '' : t('The drive may be partly written.'), reason: res.reason, ...(res.detail ? { detail: res.detail } : {}) },
    });
  };

  const startMaskromWrite = async () => {
    if (!storage || !mb) return;
    const st = STORAGES[storage];
    // SPI NOR: refuse a storage of another size, and keep a copy of the flash first where the app can save one.
    const keepSpi = storage === 'spinor' && !!api.keepSpiBackup;
    const r: Run = {
      kind: 'maskrom', log: [], result: null, board: { name: cur?.boardName ?? mb.boardName, soc: mb.soc },
      stages: [
        { id: 'prepare', label: source === 'release' ? t('Download, check and decompress') : source === 'spi' ? t('Download and check') : source === 'update' ? t('Read the update.img') : t('Prepare the file'), percent: 0 },
        { id: 'loader', label: t('Send the loader and wait for the board'), percent: null },
        ...(keepSpi ? [{ id: 'backup', label: t('Copy the SPI NOR flash to this computer'), percent: 0 }] : []),
        { id: 'write', label: source === 'update' ? t('Write the partition table, the loader and the partitions to the {storage}', { storage: t(st.label) }) : t('Write {device}', { device: t(st.label) }), percent: 0 },
        { id: 'verify', label: t('Read back and compare'), percent: 0 },
      ],
    };
    setRun(r);
    const setStage = (id: string, patch: Partial<Run['stages'][number]>) =>
      setRun((cur) => cur && { ...cur, stages: cur.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
    const finish = (result: Run['result']) => setRun((cur) => cur && { ...cur, result });

    let prepared: PreparedFile | null = source === 'file' ? file : source === 'update' ? updateFile : WEB ? releaseFile : null;
    if (!WEB && (source === 'release' || source === 'spi') && image) {
      const off = api.onProgress((p) => setStage('prepare', { percent: p.total ? Math.min(100, Math.floor(p.bytes * 100 / p.total)) : null, detail: p.stage }));
      const res = await api.prepareMaskrom(image.id, source === 'spi' ? 'spi' : 'image');
      off();
      if ('error' in res) { finish({ ok: false, title: msg(res.error), text: t('Nothing was written.'), reason: res.error }); return; }
      prepared = res;
    }
    if (!prepared) { finish({ ok: false, title: t('No file to write was chosen.'), text: t('Nothing was written.') }); return; }
    setStage('prepare', { percent: 100, detail: undefined });
    // Rockchip's loader is not shipped: built from rkbin on first use.
    setStage('loader', { percent: null, detail: t("getting Rockchip's loader") });
    const loader = await api.getLoader(mb.loader);
    if ('error' in loader) {
      if (source !== 'file' && source !== 'update') api.releaseMaskrom(prepared.token);
      finish({ ok: false, title: msg(loader.error), text: t('Nothing was written.'), reason: loader.error });
      return;
    }
    setStage('loader', { percent: null, detail: undefined });
    const settingsNow = await api.getSettings();
    const job = startMaskrom({
      loaderUrl: loader.url, size: prepared.size, sha256: prepared.sha256,
      ...(prepared.file ? { file: prepared.file, reconnectTimeout: 180000 } : { fileUrl: prepared.url }),
      storageCode: st.code, storageLabel: st.label, verify: true, resetAfter: settingsNow.resetAfterMaskrom,
      ...(source === 'update' ? { updateImage: true } : {}),
      ...(clearGpt && (source === 'release' || source === 'file') && (storage === 'emmc' || storage === 'sd') ? { clearBackupGpt: true } : {}),
      ...(storage === 'spinor' ? { spiNor: { keep: keepSpi } } : {}),
    }, {
      backup: async (data) => {
        const kept = await api.keepSpiBackup!(mb.board, data);
        if ('path' in kept) setRun((cur) => cur && { ...cur, backup: kept.path });
        return kept;
      },
      log: (line) => setRun((cur) => cur && { ...cur, log: [...cur.log, line] }),
      stage: (s: Stage) => {
        if (s === 'loader' || s === 'reconnect') setStage('loader', { percent: null, detail: s === 'reconnect' ? t('waiting for the board') : undefined });
        // A browser forgets the board when it restarts in Loader mode; it has
        // to be chosen again (the desktop app finds it by itself).
        if (s === 'reconnect' && WEB) setReconnect(true);
        if (s === 'storage') { setReconnect(false); setStage('loader', { percent: 100, detail: undefined }); }
      },
      progress: (s, pct) => { if (s === 'backup' || s === 'write' || s === 'verify') setStage(s, { percent: pct }); },
    });
    maskromJob.current = job;
    let res: Awaited<typeof job.done>;
    try {
      res = await job.done;
    } catch (e) {
      // As in startSd: never leave a run without a result.
      res = { ok: false, reason: 'The write stopped with an error.', detail: String((e as Error)?.message ?? e) };
    }
    maskromJob.current = null;
    setReconnect(false);
    if (source !== 'file' && source !== 'update') api.releaseMaskrom(prepared.token);
    const restarting = settingsNow.resetAfterMaskrom ? t(' The board is restarting.') : '';
    const mib = (n: number) => `${Math.floor(n / 1048576)} MiB`;
    if ('checks' in res) {
      const c = res.checks;
      const past = c.matched + c.filler + c.unsure;
      finish({ ok: true, warning: c.unsure > 0, title: t('Written'),
        text: t('{name} is on the {storage}: the partition table, the loader and {size} of partitions.', { name: prepared.name, storage: t(st.label), size: formatBytes(res.written) })
          + t(' Everything written in the first 32 MiB read back as written ({size}).', { size: formatBytes(c.headBytes) })
          + (past ? t(" Of {n} samples further on, {matched} matched, {filler} came back as the loader's filler and {unsure} differently; past 32 MiB this loader's reads are not trustworthy, so those say nothing about the write.", { n: past, matched: c.matched, filler: c.filler, unsure: c.unsure }) : '')
          + restarting });
      return;
    }
    const gpt = 'clearedBackupGpt' in res && res.clearedBackupGpt ? t(' The old backup partition table at the end was cleared.') : '';
    const where = { name: prepared.name, storage: t(st.label) };
    finish(!res.ok
      ? { ok: false, title: msg(res.reason), text: t('Check the connection and the output below.'), reason: res.reason,
        ...(res.detail ? { detail: res.detail } : {}), ...(res.reason.startsWith(BOARD_GONE) ? { gone: true } : {}) }
      : res.verified === 'match'
        ? { ok: true, title: t('Written and verified'), text: t('{name} is on the {storage}. The read-back matches (SHA-256 {sha}).', { ...where, sha: res.sha256 }) + gpt + restarting }
        : res.verified === 'partial'
          ? { ok: true, warning: true, title: t('Written; the first {size} verified', { size: mib(res.verifiedBytes) }),
            text: t("{name} is on the {storage}. The first {size} read back as written. Past that, this board's loader returns filler when the {storage} is read over USB, so the rest could not be checked; the write itself went through. Booting the board from it shows it works.", { ...where, size: mib(res.verifiedBytes) }) + gpt + restarting }
          : { ok: true, warning: true, title: t('Written, not verified'), text: t('{name} is on the {storage}. There was no checksum to compare it with, so it was not read back.', where) + gpt + restarting });
  };

  // A start that throws (an IPC call that failed) ends on the run page with
  // Try again, never in a run that waits for nothing.
  const guarded = (start: () => Promise<void>) => start().catch((e: unknown) => {
    const reason = String((e as Error)?.message ?? e);
    setRun((cur) => ({ ...(cur ?? { kind: method, stages: [], log: [] }), result: { ok: false, title: msg(reason), text: '', reason } }));
  });
  // A save erases nothing, so it needs no second question.
  const onWrite = () => { if (method === 'file') guarded(startSave); else setConfirm(true); };
  const doWrite = () => {
    setConfirm(false);
    if (method === 'sd') { guarded(startSd); return; }
    if (WEB) {
      // WebUSB only shows devices the user picked; this click is the gesture.
      navigator.usb.requestDevice({ filters: [{ vendorId: 0x2207 }] })
        .then(() => guarded(startMaskromWrite), () => setFileError(t('No board was chosen. Connect it in Maskrom mode and try again.')));
      return;
    }
    guarded(startMaskromWrite);
  };
  // Try again: the same write with every choice kept; what it erases was confirmed already.
  const retry = () => { if (method === 'file') guarded(startSave); else doWrite(); };
  // After a failure the wizard opens at Review, with every choice kept.
  const [wizardStart, setWizardStart] = useState(1);
  const backToSteps = () => { setWizardStart(4); setRun(null); };
  useEffect(() => {
    if (run || wizardStart === 1) return undefined;
    // Opened at Review once; afterwards the wizard starts at the first step as before.
    const id = setTimeout(() => setWizardStart(1), 0);
    return () => clearTimeout(id);
  }, [run, wizardStart]);
  const problemFacts = (): ProblemFacts => ({
    board: cur?.boardName ?? null,
    image: !custom && image ? (method === 'maskrom' && source === 'spi' && image.spi ? image.spi.file : method === 'maskrom' && (source === 'file' || source === 'update') ? null : image.file) : null,
    destination: method === 'sd' ? (target?.internal ? 'a built-in disk' : 'SD card or USB drive')
      : method === 'file' ? 'an image file'
      : storage ? `${STORAGES[storage].label}, over Maskrom${source === 'file' ? ' (a file on this computer)' : source === 'update' ? ' (a Rockchip update.img)' : ''}` : null,
    step: run?.stages.find((x) => x.percent !== 100)?.label ?? null,
    error: run?.result?.reason ?? run?.result?.title ?? null, detail: run?.result?.detail ?? null, log: run?.log ?? [],
  });
  const [stopAsk, setStopAsk] = useState(false);
  const cancel = () => {
    setStopAsk(false);
    if (maskromJob.current) maskromJob.current.cancel();
    else api.cancel();
  };
  // While a write runs, closing the window asks first (main.ts), in the page's language.
  const running = !!run && !run.result;
  useEffect(() => {
    api.setBusy?.(running ? {
      title: t('Stop now?'), stay: t('Keep going'), leave: t('Close anyway'),
      text: t('A write is running. Closing the window stops it, and what is being written is left incomplete.'),
    } : null);
  }, [running, pageLang]);
  // In a browser the page can only ask with the browser's own words.
  useEffect(() => {
    if (!WEB || !running) return undefined;
    const ask = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [running]);

  const finishRun = () => { setRun(null); setDevice(null); setSaveTarget(null); };

  // Notices about the whole app sit under the first step's title. The ones
  // that stop a write (sample data, no WebUSB) show again on the review.
  const noUsb = WEB && !('usb' in navigator) && (
    <Alert isInline variant="warning" title={t('This browser cannot reach USB devices')}>
      {t('Writing over USB needs WebUSB, which Chrome, Edge and other Chromium browsers have. Or use the')}{' '}
      <Button variant="link" isInline component="a" href={DESKTOP_URL} target="_blank">{t('desktop app')}</Button>{t('.')}
    </Alert>
  );
  const sampleNote = sample && (
    <Alert isInline variant="warning" title={t('Sample data')}
      actionLinks={<Button variant="link" isInline onClick={() => setUseSample(false)}>{t('Load the real releases')}</Button>}>
      {t('These entries come from the sample catalog in the release contract. The releases do not exist and nothing can be written.')}
    </Alert>
  );
  const notices = (
    <>
      {noUsb}
      {sampleNote}
    </>
  );
  const writeNotices = <>{noUsb}{sampleNote}</>;

  return (
    <Shell onSettings={() => setSettings(true)}>
      {/* A newer version: above the wizard, never during a write. */}
      {!run && offer && dismissed !== offer.version && (
        <PageSection aria-label={t('Update')} className="update-notice">
          <Alert isInline variant="info" title={t('Roxora Imager {version} is available', { version: offerName(offer) })}
            actionClose={<AlertActionCloseButton onClose={() => dismissUpdate(offer.version)} />}
            actionLinks={(
              <>
                <AlertActionLink onClick={() => setUpdating(true)}>{t('Update')}</AlertActionLink>
                <AlertActionLink component="a" href={offer.url} target="_blank">{t('Release notes')}</AlertActionLink>
              </>
            )}>
            {offer.notes}
          </Alert>
        </PageSection>
      )}
      {run ? <RunView run={run} onCancel={() => setStopAsk(true)} onDone={finishRun} onRetry={retry} onBack={backToSteps} facts={problemFacts} reconnect={reconnect} /> : (
        <PageSection type="wizard" isFilled hasBodyWrapper={false} aria-label={t('Write an image')}>
          <Wizard navAriaLabel={t('Steps')} isVisitRequired startIndex={wizardStart} header={<Jump to={jump} done={() => setJump(null)} />} onStepChange={(_e, step) => { if (step.id === 'dest' && method === 'sd') refreshDrives(); }}>
            <WizardStep name={t('Board')} id="board" footer={{ isNextDisabled: !board && !local, isCancelHidden: true, nextButtonText: t('Next'), backButtonText: t('Back') }}>
              {/* Choosing a board means choosing among its release images: a custom file goes. */}
              <BoardStep catalog={catalog} boards={boards} board={board} reload={load}
                setBoard={(b) => { if (b !== board) setLocal(null); chooseBoard(b); }}
                find={{ query, setQuery, vendor, setVendor }} notices={notices} lp={lp} />
            </WizardStep>
            <WizardStep name={t('Image')} id="image" isDisabled={!board && !local} footer={{ isNextDisabled: !imageId && !local, isCancelHidden: true, nextButtonText: t('Next'), backButtonText: t('Back') }}>
              <ImageStep board={cur} imageId={imageId} setImage={(id) => { setLocal(null); setImageId(id); }} lp={lp} />
            </WizardStep>
            <WizardStep name={t('Destination')} id="dest" isDisabled={!imageId && !local} footer={{ isNextDisabled: !destReady, isCancelHidden: true, nextButtonText: t('Review'), backButtonText: t('Back') }}>
              <DestinationStep boardName={cur?.boardName ?? ''} boardId={board ?? ''} image={image}
                method={method} setMethod={(m) => { setMethod(m); if (m === 'sd') refreshDrives(); }}
                drives={drives} refreshDrives={refreshDrives} device={device} setDevice={chooseDevice}
                showInternal={internalSwitch ? showInternal : null} setShowInternal={toggleInternal}
                storage={storage} setStorage={(s) => { setStorage(s); setSource(mb?.wholeImage.includes(s) ? 'release' : s === 'spinor' && image?.spi ? 'spi' : 'file'); }}
                source={source} setSource={setSource} file={file} pickFile={pickFile} picking={picking} fileError={fileError}
                updateFile={updateFile} pickUpdate={pickUpdate} clearGpt={clearGpt} setClearGpt={setClearGpt}
                releaseFile={releaseFile} pickRelease={pickRelease} checking={checking}
                downloadRelease={downloadRelease} proxyError={proxyError} custom={custom} spiProblem={spiProblem}
                saveTarget={saveTarget} pickSave={pickSave} savePicking={savePicking} saveError={saveError ?? saveShort} />
            </WizardStep>
            <WizardStep name={t('Review')} id="review" isDisabled={!destReady}
              footer={<ReviewFooter canWrite={!why} why={why} onWrite={onWrite} save={method === 'file'} />}>
              <StepPage title={t('Review')} notices={writeNotices}
                lead={t(method === 'file' ? 'Nothing has been saved yet. Check this before you go on.' : 'Nothing has been written yet. Check this before you go on.')}>
                {erasedWhat && <Alert isInline variant="danger" title={t('Everything on {what} will be erased.', { what: erasedWhat })} />}
              <DescriptionList isHorizontal>
                {!custom && <DescriptionListGroup><DescriptionListTerm>{t('Board')}</DescriptionListTerm><DescriptionListDescription>{cur?.boardName}</DescriptionListDescription></DescriptionListGroup>}
                {custom && local && (
                  <>
                    <DescriptionListGroup><DescriptionListTerm>{t('Image')}</DescriptionListTerm><DescriptionListDescription>{t('{name}, {size}, a file on this computer', { name: local.name, size: formatBytes(local.size) })}</DescriptionListDescription></DescriptionListGroup>
                    <DescriptionListGroup><DescriptionListTerm>{t('Release')}</DescriptionListTerm><DescriptionListDescription>{t('Not a Roxora release image. It was not checked against one.')}</DescriptionListDescription></DescriptionListGroup>
                  </>
                )}
                {!custom && (method !== 'maskrom' || source === 'release') && image && (
                  <>
                    <DescriptionListGroup><DescriptionListTerm>{t('Image')}</DescriptionListTerm><DescriptionListDescription>{image.file}</DescriptionListDescription></DescriptionListGroup>
                    <DescriptionListGroup><DescriptionListTerm>{t('Release')}</DescriptionListTerm><DescriptionListDescription>{releaseWords(image)}, {image.releaseInfo.date}</DescriptionListDescription></DescriptionListGroup>
                  </>
                )}
                {method !== 'maskrom' && local?.imageId && (
                  <DescriptionListGroup><DescriptionListTerm>{t('File')}</DescriptionListTerm><DescriptionListDescription>{t('{name} on this computer; its SHA-256 matches the release', { name: local.name })}</DescriptionListDescription></DescriptionListGroup>
                )}
                {method === 'maskrom' && source === 'spi' && image?.spi && (
                  <DescriptionListGroup><DescriptionListTerm>{t('SPI bootloader')}</DescriptionListTerm><DescriptionListDescription>{t('{file}, {size}, from {release}', { file: image.spi.file, size: formatBytes(image.spi.size), release: releaseWords(image) })}</DescriptionListDescription></DescriptionListGroup>
                )}
                {WEB && source !== 'file' && releaseFile && (
                  <DescriptionListGroup><DescriptionListTerm>{t('Release file')}</DescriptionListTerm><DescriptionListDescription>{t('{name}, matches the release SHA-256', { name: releaseFile.name })}</DescriptionListDescription></DescriptionListGroup>
                )}
                {method === 'maskrom' && source === 'update' && updateFile && (
                  <DescriptionListGroup><DescriptionListTerm>update.img</DescriptionListTerm><DescriptionListDescription>{updateFile.name}, {formatBytes(updateFile.size)}: {updateWords(updateFile)}</DescriptionListDescription></DescriptionListGroup>
                )}
                {method === 'maskrom' && clearGpt && (source === 'release' || source === 'file') && (storage === 'emmc' || storage === 'sd') && (
                  <DescriptionListGroup><DescriptionListTerm>{t('Also')}</DescriptionListTerm><DescriptionListDescription>{t('The old backup partition table at the end of the storage is cleared after the image.')}</DescriptionListDescription></DescriptionListGroup>
                )}
                {method === 'maskrom' && storage === 'spinor' && api.keepSpiBackup && (
                  <DescriptionListGroup><DescriptionListTerm>{t('Kept')}</DescriptionListTerm><DescriptionListDescription>{t('Before writing, the SPI NOR flash is copied to a folder on this computer; the page then shows where.')}</DescriptionListDescription></DescriptionListGroup>
                )}
                {method === 'maskrom' && source === 'file' && file && (
                  <DescriptionListGroup><DescriptionListTerm>{t('File')}</DescriptionListTerm><DescriptionListDescription>{file.name}, {formatBytes(file.size)}</DescriptionListDescription></DescriptionListGroup>
                )}
                <DescriptionListGroup><DescriptionListTerm>{t('Destination')}</DescriptionListTerm><DescriptionListDescription>
                  {method === 'sd' ? (target ? `${target.description}, ${target.device}, ${formatBytes(target.size)}` : '')
                    : method === 'file' ? (saveTarget ? `${saveTarget.path}${saveNeed ? `, ${formatBytes(saveNeed)}` : ''}` : '')
                    : (storage ? t('{storage} of the board, over USB in Maskrom mode', { storage: t(STORAGES[storage].label) }) : '')}
                </DescriptionListDescription></DescriptionListGroup>
                {method === 'file' && (
                  <DescriptionListGroup><DescriptionListTerm>{t('Boots')}</DescriptionListTerm><DescriptionListDescription>{bootNote(image, custom)}</DescriptionListDescription></DescriptionListGroup>
                )}
                <DescriptionListGroup><DescriptionListTerm>{t('Checks')}</DescriptionListTerm><DescriptionListDescription>
                  {method === 'file' ? saveChecks
                    : custom ? t('The image is read once to take its SHA-256. After writing, the drive is read back and compared with it. Nothing is compared with a Roxora release.')
                    : method === 'sd' && local ? t('The file is checked against the release SHA-256 again. After writing, the drive is read back and compared with the release SHA-256.')
                    : method === 'maskrom' && source === 'update' ? t("The MD5 inside the update.img was checked when it was chosen. After writing, everything written in the first 32 MiB of the eMMC is read back and compared; past that, samples of each partition are compared, and one that differs is reported, not taken as a failed write (this loader's reads past 32 MiB are not trustworthy).")
                    : method === 'sd' || source === 'release' || source === 'spi'
                    ? t('The download is checked against the release SHA-256. After writing, the destination is read back and compared with the release SHA-256.')
                    : t('After writing, the storage is read back and compared with the file.')}
                </DescriptionListDescription></DescriptionListGroup>
              </DescriptionList>
              </StepPage>
            </WizardStep>
          </Wizard>
        </PageSection>
      )}

      <Modal isOpen={!!askInternal} onClose={() => setAskInternal(null)} variant="small" aria-labelledby="internal-title">
        <ModalHeader title={t('Use a built-in disk?')} labelId="internal-title" titleIconVariant="warning" />
        {askInternal && askInternal.internal && (
          <ModalBody>
            {t('{device} is the built-in {kind} of this computer ({what}). Nothing on it is mounted now, but it may hold a system or data you need. Writing the image erases all of it.', {
              device: askInternal.device, kind: t(INTERNAL_WORDS[askInternal.internal]),
              what: `${askInternal.description ? `${askInternal.description}, ` : ''}${formatBytes(askInternal.size)}` })}
          </ModalBody>
        )}
        <ModalFooter>
          <Button variant="danger" onClick={() => { if (askInternal) setDevice(askInternal.device); setAskInternal(null); }}>
            {askInternal ? t('Use {device}', { device: askInternal.device }) : t('Use this disk')}
          </Button>
          <Button variant="link" onClick={() => setAskInternal(null)}>{t('Cancel')}</Button>
        </ModalFooter>
      </Modal>

      <Modal isOpen={confirm} onClose={() => setConfirm(false)} variant="small" aria-labelledby="confirm-title">
        <ModalHeader title={t('Erase and write?')} labelId="confirm-title" titleIconVariant="warning" />
        <ModalBody>{erased} {t('This cannot be undone.')}</ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={doWrite}>{t('Erase and write')}</Button>
          <Button variant="link" onClick={() => setConfirm(false)}>{t('Cancel')}</Button>
        </ModalFooter>
      </Modal>

      <Modal isOpen={stopAsk && running} onClose={() => setStopAsk(false)} variant="small" aria-labelledby="stop-title">
        <ModalHeader title={t('Stop now?')} labelId="stop-title" titleIconVariant="warning" />
        <ModalBody>{t('If writing has started, what is being written is left incomplete, and the board, card or drive may not start until it is written again. Nothing is undone.')}</ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={cancel}>{t('Stop')}</Button>
          <Button variant="link" onClick={() => setStopAsk(false)}>{t('Keep going')}</Button>
        </ModalFooter>
      </Modal>

      <Modal isOpen={!!usbChoices} onClose={() => { api.answerUsbChoice(''); setUsbChoices(null); }} variant="small" aria-labelledby="usb-title">
        <ModalHeader title={t('Several Rockchip devices are connected')} labelId="usb-title" />
        <ModalBody>
          <Stack hasGutter>
            <Content component="p">{t('Choose the board to write, or disconnect the others.')}</Content>
            {usbChoices?.map((c) => (
              <StackItem key={c.deviceId}>
                <Button variant="secondary" onClick={() => { api.answerUsbChoice(c.deviceId); setUsbChoices(null); }}>
                  {c.productName || t('Rockchip device')} ({t('product')} 0x{c.productId.toString(16)})
                </Button>
              </StackItem>
            ))}
          </Stack>
        </ModalBody>
      </Modal>

      <SettingsModal open={settings} onClose={() => setSettings(false)} theme={theme} setTheme={setTheme}
        onOffer={setOffer} onUpdate={() => { setSettings(false); setUpdating(true); }} writing={!!run && !run.result}
        onAbout={() => { setSettings(false); setAbout(true); }} />
      <AboutModal open={about} onClose={() => setAbout(false)} />
      <UpdateModal offer={updating && !(run && !run.result) ? offer : null} onClose={() => setUpdating(false)} />
    </Shell>
  );
}
