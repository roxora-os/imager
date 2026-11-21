import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionList, ActionListGroup, ActionListItem, Alert, AlertActionCloseButton, AlertActionLink, Button, CodeBlock, CodeBlockAction, CodeBlockCode, Content, DescriptionList,
  DescriptionListDescription, DescriptionListGroup, DescriptionListTerm, EmptyState, EmptyStateActions, EmptyStateBody,
  EmptyStateFooter, ExpandableSection, Flex, FlexItem, Form, FormGroup, FormSelect, FormSelectOption, Masthead,
  MastheadBrand, MastheadContent, MastheadLogo, MastheadMain, Modal, ModalBody, ModalFooter, ModalHeader, Page,
  PageSection, Progress, ProgressMeasureLocation, Radio, SearchInput, Sidebar, SidebarContent, SidebarPanel, SimpleList,
  SimpleListItem,
  Spinner, Stack, StackItem, Switch, Title, ToggleGroup, ToggleGroupItem, Toolbar, ToolbarContent, ToolbarGroup,
  ToolbarItem, Wizard, WizardFooterWrapper, WizardStep, Menu, MenuContent, MenuItem, MenuList,
  useWizardContext,
} from '@patternfly/react-core';
import { CogIcon } from '@patternfly/react-icons/dist/esm/icons/cog-icon';
import { GlobeIcon } from '@patternfly/react-icons/dist/esm/icons/globe-icon';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import {
  compareImages, flavorWords, groupByBoard, splitByRelease, type Board, type CatalogImage, type CatalogRelease, type ImageSortKey,
} from '../shared/catalog';
import { BOARD_REQUEST_URL, queryWords, vendorCounts, visibleBoards } from '../shared/boardsearch';
import { formatBytes, uncompressedName } from '../shared/format';
import type { CatalogResult, ImagerApi, JobProgress, LocalImage, PreparedFile, SaveSubject, SaveTarget } from '../shared/ipc';
import { INTERNAL_WORDS, type HiddenDrive, type Target } from '../shared/targets';
import { APT_COMMAND, type UpdateCheck, type UpdateOffer, type UpdateResult } from '../shared/update';
import { maskromBoard, STORAGES, type StorageId } from '../maskrom/boards';
import { RKBIN_HOST } from '../maskrom/loaders';
import { SPI_FLASH_FALLBACK, spiFileProblem } from '../maskrom/spi-check';
import type { Stage } from '../maskrom/sequence';
import { startMaskrom, type MaskromJob } from './maskrom-client';
import { readTheme, applyTheme, type Theme } from './theme';
import { useI18n } from './i18n';
import { MESSAGES } from './messages';
import { LANG_NAMES, LANGS, type Lang, type T } from '../shared/i18n';

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
const loaderNote = (t: T) => t('maskrom.loaderNote', { host: RKBIN_HOST });
/** Between two sentences or a sentence and a link: a space in English, nothing in Chinese. */
const gap = (lang: Lang) => (lang === 'en' ? ' ' : '');
/** A storage's name and note (maskrom/boards.ts), in the page's language. */
const storageLabel = (t: T, s: StorageId) => t(`storage.${s}`);
/** A desktop flavor by its catalog name; one this version does not know keeps that name. */
const flavorText = (t: T, f: string) => (MESSAGES[`flavor.${f}`] ? t(`flavor.${f}`) : flavorWords(f));
const internalText = (t: T, k: keyof typeof INTERNAL_WORDS) => t(`internal.${k}`);

type Method = 'sd' | 'maskrom' | 'file';
type MaskromSource = 'release' | 'spi' | 'file';
/** A release file being downloaded or checked: what, and how far. */
interface Checking { label: string; done: number; total: number }

interface Run {
  kind: Method;
  /** `done`: what to show in place of a percentage that is not known (bytes so far). */
  stages: { id: string; label: string; percent: number | null; detail?: string; done?: string }[];
  log: string[];
  result: { ok: boolean; warning?: boolean; title: string; text: string; detail?: string } | null;
  /** A save to a file: its token, for Show in folder. */
  saved?: string;
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
function bootNote(t: T, img: CatalogImage | undefined, custom: boolean): string {
  const vm = t('boot.vm');
  if (custom) return t('boot.custom', { vm });
  if (isUefiImage(img)) return t('boot.uefi', { vm });
  return img ? t('boot.board', { board: img.boardName, vm }) : t('boot.anyBoard', { vm });
}

/** The last part of a path, for Windows paths as well. */
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** What a Maskrom write takes by default: the whole image where it fits, else the release's SPI bootloader, else a file. */
function defaultSource(m: ReturnType<typeof maskromBoard>, img: CatalogImage | undefined): MaskromSource {
  if (m?.imageStorage) return 'release';
  if (img?.spi && m?.storages.includes('spinor')) return 'spi';
  return 'file';
}

function releaseWords(t: T, img: CatalogImage): string {
  return t(img.releaseInfo.prerelease ? 'release.beta' : 'release.release', { version: img.releaseInfo.version });
}

/*
 * The page shell, laid out as Fedora's installer (anaconda-webui) does it:
 * a masthead, then one wizard that fills the rest of the window, its step
 * nav running the full height and its footer pinned to the bottom.
 */
function Shell({ children, onSettings }: { children: React.ReactNode; onSettings: () => void }) {
  const { t, lang } = useI18n();
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
                <Button variant="plain" icon={<GlobeIcon />} aria-label={t('lang.dialog')} title={t('lang.dialog')}
                  className="lang-button" onClick={() => setLangOpen(true)}>
                  <span lang={lang}>{LANG_NAMES[lang]}</span>
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button variant="plain" icon={<CogIcon />} onClick={onSettings}>{t('settings')}</Button>
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
 * The language dialog, as Cockpit's "Display language" (shell-modals.jsx):
 * a small modal with a plain menu of the languages, each in its own
 * language, the current one selected, and Select / Cancel.
 */
function LangModal({ onClose }: { onClose: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [picked, setPicked] = useState(lang);
  const apply = () => { if (picked !== lang) setLang(picked); onClose(); };
  return (
    <Modal isOpen variant="small" onClose={onClose} aria-labelledby="lang-dialog-title" id="lang-dialog">
      <ModalHeader title={t('lang.dialog')} labelId="lang-dialog-title" />
      <ModalBody>
        <Menu isPlain isScrollable activeItemId={picked} selected={picked}
          onSelect={(_e, id) => setPicked(id as Lang)}>
          <MenuContent>
            <MenuList>
              {LANGS.map((l) => (
                <MenuItem key={l} itemId={l} isSelected={picked === l} lang={l}>{LANG_NAMES[l]}</MenuItem>
              ))}
            </MenuList>
          </MenuContent>
        </Menu>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={apply}>{t('lang.select')}</Button>
        <Button variant="link" onClick={onClose}>{t('cancel')}</Button>
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
/** The file chosen for the SD/USB path, and plainly whether a release vouches for it. */
function LocalImageRow({ lp }: { lp: LocalPick }) {
  const { t, msg } = useI18n();
  if (!api.pickLocalImage) return null;
  const { local } = lp;
  return (
    <Stack hasGutter className="local-image">
      <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
        <FlexItem flex={{ default: 'flexNone' }}>
          <Button variant="secondary" onClick={lp.pick} isLoading={lp.busy} isDisabled={lp.busy}>{t('local.button')}</Button>
        </FlexItem>
        <FlexItem>
          {local ? t('pair', { a: local.name, b: formatBytes(local.size) }) : t('local.hint')}
        </FlexItem>
        {local && <FlexItem><Button variant="link" isInline onClick={lp.clear}>{t('remove')}</Button></FlexItem>}
      </Flex>
      {lp.error && <Alert variant="danger" isInline isPlain title={msg(lp.error)} />}
      {local && !local.imageId && (
        <Alert isInline variant="warning" title={t('local.custom.title')}>
          {t('local.custom.text', { name: local.name })}
        </Alert>
      )}
      {local?.imageId && (
        <Alert isInline variant="success" title={t('local.release.title')}>
          {t('local.release.text')}
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
  const { t, lang, msg } = useI18n();
  // Without the release list a downloaded image can still be written.
  const localAction = api.pickLocalImage && (
    <Button variant="secondary" onClick={lp.pick} isLoading={lp.busy} isDisabled={lp.busy}>{t('local.button')}</Button>
  );
  const localError = lp.error && <EmptyStateBody><Alert variant="danger" isInline isPlain title={msg(lp.error)} /></EmptyStateBody>;
  if (!catalog) return <EmptyState titleText={t('board.loading')} headingLevel="h2" icon={Spinner} />;
  if (catalog.state === 'error') {
    return (
      <EmptyState titleText={t('board.error')} headingLevel="h2">
        <EmptyStateBody>{msg(catalog.message)}</EmptyStateBody>
        {localError}
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="secondary" onClick={reload}>{t('tryAgain')}</Button>
            {localAction}
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  }
  if (catalog.state === 'none') {
    return (
      <EmptyState titleText={t('board.none.title')} headingLevel="h2">
        <EmptyStateBody>{t('board.none.text')}</EmptyStateBody>
        {localError}
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="secondary" onClick={reload}>{t('board.checkAgain')}</Button>
            {localAction}
            <Button variant="link" component="a" href={RELEASES_URL} target="_blank">{t('board.releasesGithub')}</Button>
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  }
  return (
    <StepPage title={t('step.board')} notices={notices} lead={api.pickLocalImage ? (
      <>
        {t('board.lead')}{gap(lang)}{t('board.leadLocal')}{' '}
        <Button variant="link" isInline onClick={lp.pick} isDisabled={lp.busy}>{t('local.button')}</Button>
      </>
    ) : t('board.lead')}>
      {lp.error && <Alert variant="danger" isInline isPlain title={msg(lp.error)} />}
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
  const { t } = useI18n();
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
        <SearchInput placeholder={t('board.search')} value={query} aria-label={t('board.search')}
          onChange={(_e, v) => setQuery(v)} onClear={() => setQuery('')} />
      </div>
      <Sidebar hasGutter>
        <SidebarPanel width={{ default: 'width_25' }}>
          <div className="vendor-select">
            <FormSelect value={active} onChange={(_e, v) => pick(v)} aria-label={t('board.vendor')}>
              <FormSelectOption value={ALL} label={vendorLabel(t('board.allVendors'), total)} />
              {counts.map((c) => (
                <FormSelectOption key={c.vendor} value={c.vendor} label={vendorLabel(c.vendor, c.count)} isDisabled={searching && c.count === 0} />
              ))}
            </FormSelect>
          </div>
          <nav className="vendor-list" aria-label={t('board.vendors')}>
            <SimpleList onSelect={(_ref, props) => pick(String(props.itemId ?? ALL))} isControlled={false}>
              {vendorItem(ALL, t('board.allVendors'), total)}
              {counts.map((c) => vendorItem(c.vendor, c.vendor, c.count, searching && c.count === 0))}
            </SimpleList>
          </nav>
        </SidebarPanel>
        <SidebarContent>
          {shown.length === 0 ? (
            <EmptyState titleText={t('board.noMatch', { query: query.trim() })} headingLevel="h3" variant="sm">
              <EmptyStateFooter>
                <EmptyStateActions>
                  <Button variant="link" component="a" href={BOARD_REQUEST_URL} target="_blank">{t('board.ask')}</Button>
                  <Button variant="link" onClick={() => setQuery('')}>{t('board.clear')}</Button>
                </EmptyStateActions>
              </EmptyStateFooter>
            </EmptyState>
          ) : (
            <Table aria-label={t('board.boards')} variant="compact">
              <Thead><Tr><Th screenReaderText={t('select')} /><Th>{t('col.board')}</Th><Th>{t('col.soc')}</Th><Th>{t('col.newest')}</Th></Tr></Thead>
              <Tbody>
                {shown.map((b, i) => (
                  <Tr key={b.board} isClickable onRowClick={() => setBoard(b.board)} isRowSelected={board === b.board}>
                    <Td select={{ rowIndex: i, variant: 'radio', isSelected: board === b.board, onSelect: () => setBoard(b.board) }} />
                    <Td dataLabel={t('col.board')} className="nowrap-md">{b.boardName}</Td>
                    <Td dataLabel={t('col.soc')} className="nowrap-md">{b.soc.toUpperCase()}</Td>
                    <Td dataLabel={t('col.newest')}>{releaseWords(t, b.images[0])}</Td>
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
  ['ubuntu', 'col.ubuntu', 25], ['desktop', 'col.desktop', 30], ['kernel', 'col.kernel', 25], ['size', 'col.size', 15],
];

type ImageSort = { key: ImageSortKey; dir: 'asc' | 'desc' } | null;

function releaseLabel(t: T, r: CatalogRelease): string {
  return t(r.prerelease ? 'release.label.beta' : 'release.label', { version: r.version, date: r.date });
}

function ImageTable({ label, images, selected, setImage, sort, setSort }: {
  label: string; images: CatalogImage[]; selected: string | null; setImage: (id: string) => void;
  sort: ImageSort; setSort: (s: ImageSort) => void;
}) {
  const { t } = useI18n();
  const rows = sort ? [...images].sort((x, y) => (sort.dir === 'asc' ? 1 : -1) * compareImages(x, y, sort.key)) : images;
  return (
    <Table aria-label={label} variant="compact">
      <Thead><Tr><Th screenReaderText={t('select')} />
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
            <Td dataLabel={t('col.ubuntu')}>{img.ubuntuVersion} ({img.release})</Td>
            <Td dataLabel={t('col.desktop')}>{flavorText(t, img.flavor)}</Td>
            <Td dataLabel={t('col.kernel')}>{img.kernel ? `${img.kernel} ` : ''}{img.branch}</Td>
            <Td dataLabel={t('col.size')}>{formatBytes(img.size)}</Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
}

function ImageStep({ board, imageId, setImage, lp }: {
  board: Board | undefined; imageId: string | null; setImage: (id: string) => void; lp: LocalPick;
}) {
  const { t } = useI18n();
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
    <StepPage title={t('step.image')} lead={!board ? t('image.noBoard')
      : current ? <>{t(current.release.prerelease ? 'image.leadBeta' : 'image.lead',
        { board: board.boardName, version: current.release.version, date: current.release.date })}{' '}
        <Button variant="link" isInline component="a" href={current.release.url} target="_blank">{t('releaseNotes')}</Button></>
      : t('image.leadPlain', { board: board.boardName })}>
      {current && <ImageTable label={t('image.table', { version: current.release.version })} images={current.images} {...tableProps} />}
      {older && (
        <ExpandableSection className="older-releases" isExpanded={olderOpen || selOlder}
          onToggle={(_e, open) => setOlderOpen(open)}
          toggleText={t('image.older', { n: others.length })}>
          <Stack hasGutter>
            <FormGroup label={t('image.release')} fieldId="older-release">
              <FormSelect id="older-release" value={older.release.tag} onChange={(_e, v) => setOlderTag(v)}>
                {others.map((r) => <FormSelectOption key={r.release.tag} value={r.release.tag} label={releaseLabel(t, r.release)} />)}
              </FormSelect>
            </FormGroup>
            <Alert isInline isPlain variant="info" title={older.release.prerelease
              ? t('image.betaNote')
              : t('image.olderNote', { newest: current ? t('image.roxora', { version: current.release.version }) : t('image.newest') })}>
              <Button variant="link" isInline component="a" href={older.release.url} target="_blank">{t('releaseNotes')}</Button>
            </Alert>
            <ImageTable label={t('image.table', { version: older.release.version })} images={older.images} {...tableProps} />
          </Stack>
        </ExpandableSection>
      )}
      {sel && selOlder && (
        <Content component="p" className="step-lead">
          {t(sel.releaseInfo.prerelease ? 'image.selectedBeta' : 'image.selectedOlder', { release: releaseWords(t, sel) })}
        </Content>
      )}
      <LocalImageRow lp={lp} />
    </StepPage>
  );
}

function DriversNote() {
  const { t } = useI18n();
  if (WEB) {
    return (
      <Content component="p">
        {t('drivers.web.1')}{' '}
        <Button variant="link" isInline component="a" href="https://zadig.akeo.ie/" target="_blank">Zadig</Button>{' '}
        {t('drivers.web.2')}
      </Content>
    );
  }
  if (api.platform === 'win32') {
    return (
      <Content component="p">
        {t('drivers.windows')}{' '}
        <Button variant="link" isInline component="a" href="https://zadig.akeo.ie/" target="_blank">zadig.akeo.ie</Button>
      </Content>
    );
  }
  if (api.platform === 'linux') {
    return (
      <>
        <Content component="p">{t('drivers.linux')}</Content>
        <CopyBlock text={'echo \'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/70-roxora-imager.rules\nsudo udevadm control --reload-rules && sudo udevadm trigger'} />
      </>
    );
  }
  return <Content component="p">{t('drivers.mac')}</Content>;
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
  releaseFile: PreparedFile | null; pickRelease: () => void; checking: Checking | null;
  downloadRelease: () => void; proxyError: string | null;
  /** An image file from this computer that is no release image: SD card or USB drive only. */
  custom: boolean;
  /** Why the chosen file must not go to SPI NOR flash (maskrom/spi-check.ts). */
  spiProblem: string | null;
  /** Save as an image file: where, choosing it, and why it cannot go there. */
  saveTarget: SaveTarget | null; pickSave: () => void; savePicking: boolean; saveError: string | null;
}) {
  const { t, lang, msg } = useI18n();
  const mb = maskromBoard(p.boardId);
  const sp = gap(lang);
  const imageNote = (m: NonNullable<typeof mb>) => (MESSAGES[`imageNote.${m.board}`] ? t(`imageNote.${m.board}`) : m.imageNote);
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
          label={p.checking.total ? t('bytesOf', { done: formatBytes(p.checking.done), total: formatBytes(p.checking.total) }) : undefined} />
      );
    }
    if (viaProxy) {
      return fileRow(
        <Button variant="secondary" onClick={p.downloadRelease}>{t('dest.download')}</Button>,
        p.releaseFile ? t('dest.downloaded', { name: p.releaseFile.name })
          : relFile ? t('dest.through', { file: relFile.file, size: formatBytes(relFile.size), proxy: api.downloadProxy ?? '' }) : '',
      );
    }
    return fileRow(
      <Button variant="secondary" onClick={p.pickRelease}>{t('dest.chooseDownloaded')}</Button>,
      p.releaseFile ? t('dest.matches', { name: p.releaseFile.name }) : t('noFile'),
    );
  };
  // When the proxy download fails the reason is up under the title: bring it into view.
  const byHandRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (p.proxyError) byHandRef.current?.scrollIntoView({ block: 'nearest' }); }, [p.proxyError]);
  const byHand = !!relFile && !viaProxy && !p.releaseFile && (
    <Alert ref={byHandRef} isInline variant={p.proxyError ? 'warning' : 'info'} title={t('dest.byHand.title')}>
      {relParts.length > 0 ? (
        <>
          {t('dest.byHand.parts1', { n: relParts.length })}<code>cat {relFile.file}.part* &gt; {relFile.file}</code>{t('dest.byHand.parts2')}{' '}
          {relParts.map((part, i) => (
            <span key={part.file}>{i > 0 ? ', ' : ''}<Button variant="link" isInline component="a" href={part.url}>{part.file}</Button></span>
          ))}
        </>
      ) : (
        <>
          {p.proxyError ? msg(p.proxyError) : t('dest.byHand.cors')}{sp}{t('dest.byHand.then')}{' '}
          <Button variant="link" isInline component="a" href={relFile.url}>{relFile.file}</Button>
        </>
      )}
    </Alert>
  );
  const lead = WEB ? (
    <>
      {t('dest.web.1')}{' '}
      <Button variant="link" isInline component="a" href={DESKTOP_URL} target="_blank">{t('dest.web.app')}</Button>{t('list.or2')}<Button variant="link" isInline component="a" href={RPI_IMAGER_URL} target="_blank">Raspberry Pi Imager</Button>{t('dest.web.end')}
      {sp}{mb ? `${t('dest.web.maskrom', { board: p.boardName })}${sp}${loaderNote(t)}` : t('maskrom.notSetUp', { board: p.boardName })}
    </>
  ) : undefined;
  return (
    <StepPage title={t('step.dest')} lead={lead} notices={byHand || undefined}>
      <Form className="destination" onSubmit={(e) => e.preventDefault()}>
        {!WEB && (
          <FormGroup role="radiogroup" fieldId="method" label={t('dest.writeTo')} isStack>
            <Radio id="method-sd" name="method" isChecked={p.method === 'sd'} onChange={() => p.setMethod('sd')}
              label={t('dest.sd')} description={t('dest.sd.desc')} />
            <Radio id="method-maskrom" name="method" isChecked={p.method === 'maskrom'} onChange={() => p.setMethod('maskrom')}
              isDisabled={!mb || p.custom}
              label={t('dest.maskrom')}
              description={p.custom ? t('dest.maskrom.custom')
                : mb ? `${t('dest.maskrom.desc', { storages: mb.storages.map((s) => storageLabel(t, s)).join(t('list.or')) })}${sp}${loaderNote(t)}`
                : t('maskrom.notSetUp', { board: p.boardName })} />
            {api.pickSaveFile && (
              <Radio id="method-file" name="method" isChecked={p.method === 'file'} onChange={() => p.setMethod('file')}
                label={t('dest.file')}
                description={`${t('dest.file.desc')}${sp}${bootNote(t, p.image, p.custom)}`}
                body={p.method === 'file' ? (
                  <Stack hasGutter>
                    {fileRow(
                      <Button variant="secondary" onClick={p.pickSave} isLoading={p.savePicking} isDisabled={p.savePicking}>{t('dest.file.choose')}</Button>,
                      p.saveTarget ? p.saveTarget.path : t('dest.file.none'),
                    )}
                    {p.saveError && <Alert variant="danger" isInline isPlain title={msg(p.saveError)} />}
                  </Stack>
                ) : undefined} />
            )}
          </FormGroup>
        )}

        {p.method === 'sd' && (
          <FormGroup fieldId="drives" label={t('dest.drive')}
            labelInfo={(
              <Flex className="drive-actions" spaceItems={{ default: 'spaceItemsLg' }} alignItems={{ default: 'alignItemsCenter' }}
                justifyContent={{ default: 'justifyContentFlexEnd' }} flexWrap={{ default: 'nowrap' }}>
                {p.showInternal !== null && (
                  <FlexItem>
                    <Switch id="show-internal" className="show-internal" label={t('dest.showInternal')} isChecked={p.showInternal}
                      onChange={(_e, v) => p.setShowInternal(v)} aria-describedby="show-internal-note" />
                  </FlexItem>
                )}
                <FlexItem><Button variant="link" isInline onClick={() => p.refreshDrives()}>{t('refresh')}</Button></FlexItem>
              </Flex>
            )}>
            {p.showInternal && (
              <div id="show-internal-note" className="muted">{t('dest.internalNote')}</div>
            )}
            {!p.drives ? <Spinner size="md" aria-label={t('dest.looking')} /> : p.drives.targets.length === 0 ? (
              <Content component="p">{t('dest.noDrive')}</Content>
            ) : (
              <Table aria-label={t('dest.drives')} variant="compact" id="drives">
                <Thead><Tr><Th screenReaderText={t('select')} /><Th>{t('col.drive')}</Th><Th>{t('col.device')}</Th><Th modifier="nowrap">{t('col.size')}</Th></Tr></Thead>
                <Tbody>
                  {p.drives.targets.map((d, i) => (
                    <Tr key={d.device} isClickable={!d.disabled} onRowClick={() => !d.disabled && p.setDevice(d.device)} isRowSelected={p.device === d.device}>
                      <Td select={{ rowIndex: i, variant: 'radio', isSelected: p.device === d.device, isDisabled: !!d.disabled, onSelect: () => p.setDevice(d.device) }} />
                      <Td dataLabel={t('col.drive')}>
                        {d.internal ? (d.description ? t('labelled', { a: internalText(t, d.internal), b: d.description }) : internalText(t, d.internal)) : d.description}
                        {d.disabled && <div className="muted">{msg(d.disabled)}</div>}
                        {d.warning && !d.disabled && <div className="muted">{d.internal ? t('target.internal', { kind: internalText(t, d.internal) }) : msg(d.warning)}</div>}
                      </Td>
                      <Td dataLabel={t('col.device')}>{d.device}</Td>
                      <Td dataLabel={t('col.size')} modifier="nowrap">{formatBytes(d.size)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
            {p.drives && p.drives.hidden.length > 0 && (
              <ExpandableSection toggleText={p.drives.hidden.length === 1 ? t('dest.hidden.one') : t('dest.hidden.many', { n: p.drives.hidden.length })}>
                <Content component="ul">{p.drives.hidden.map((h) => <li key={h.device}>{h.device} {t('labelled', { a: h.description, b: msg(h.reason) })}</li>)}</Content>
              </ExpandableSection>
            )}
          </FormGroup>
        )}

        {p.method === 'maskrom' && mb && (
          <>
            <FormGroup role="radiogroup" fieldId="storage" label={t('dest.storage')} isStack>
              {mb.storages.map((s) => (
                <Radio key={s} id={`storage-${s}`} name="storage" isChecked={p.storage === s} onChange={() => p.setStorage(s)}
                  label={storageLabel(t, s)} description={t(`storage.${s}.note`)} />
              ))}
            </FormGroup>
            <FormGroup role="radiogroup" fieldId="source" label={t('dest.what')} isStack>
              <Radio id="src-release" name="source" isChecked={p.source === 'release'} onChange={() => p.setSource('release')}
                isDisabled={!p.storage || !mb.wholeImage.includes(p.storage)}
                label={p.image ? t('dest.src.release', { file: p.image.file }) : t('dest.src.releaseNoFile')}
                description={p.storage && mb.wholeImage.includes(p.storage) ? undefined
                  : imageNote(mb) ?? t('dest.src.wholeTo', { storages: mb.wholeImage.map((s) => storageLabel(t, s)).join(t('list.or2')) })}
                body={releasePicker('image')} />
              {mb.storages.includes('spinor') && (
                <Radio id="src-spi" name="source" isChecked={p.source === 'spi'} onChange={() => p.setSource('spi')}
                  isDisabled={!p.image?.spi || p.storage !== 'spinor'}
                  label={p.image?.spi ? t('dest.src.spi', { file: p.image.spi.file, size: formatBytes(p.image.spi.size) }) : t('dest.src.spiNone')}
                  description={!p.image?.spi ? t('dest.src.spi.missing')
                    : viaProxy ? t('dest.src.spi.download')
                    : WEB ? t('dest.src.spi.web')
                      : t('dest.src.spi.download')}
                  body={releasePicker('spi')} />
              )}
              <Radio id="src-file" name="source" isChecked={p.source === 'file'} onChange={() => p.setSource('file')}
                label={t('dest.src.file')}
                description={p.storage === 'spinor' ? t('dest.src.file.spi') : t('dest.src.file.any')}
                body={p.source === 'file' ? fileRow(
                  <Button variant="secondary" onClick={p.pickFile} isLoading={p.picking} isDisabled={p.picking}>{t('chooseFile')}</Button>,
                  p.file ? t('pair', { a: p.file.name, b: formatBytes(p.file.size) }) : t('noFile'),
                ) : undefined} />
              {p.fileError && <Alert variant="danger" isInline isPlain title={msg(p.fileError)} />}
              {p.spiProblem && <Alert variant="danger" isInline isPlain title={msg(p.spiProblem)} />}
            </FormGroup>
            <FormGroup fieldId="connect" label={t('dest.connect')}>
              <Content id="connect">
                <ol>
                  <li>{t('dest.connect.1')}</li>
                  <li>{t('dest.connect.2')}</li>
                  <li>{t('dest.connect.3')}</li>
                </ol>
                <DriversNote />
              </Content>
            </FormGroup>
          </>
        )}
      </Form>
    </StepPage>
  );
}

function ReviewFooter({ canWrite, why, onWrite, save }: { canWrite: boolean; why: string | null; onWrite: () => void; save: boolean }) {
  const { t } = useI18n();
  const { goToPrevStep } = useWizardContext();
  return (
    <WizardFooterWrapper>
      {/* As anaconda's footer: helper text above the buttons. */}
      <Stack hasGutter>
        {why && <Content component="p" className="footer-note">{why}</Content>}
        <ActionList>
          <ActionListGroup>
            <ActionListItem><Button variant="secondary" onClick={goToPrevStep}>{t('back')}</Button></ActionListItem>
            <ActionListItem>
              {/* A save erases nothing: the save dialog already asked before replacing a file. */}
              {save ? <Button variant="primary" onClick={onWrite} isDisabled={!canWrite}>{t('save')}</Button>
                : <Button variant="danger" onClick={onWrite} isDisabled={!canWrite}>{t('eraseWrite')}</Button>}
            </ActionListItem>
          </ActionListGroup>
        </ActionList>
      </Stack>
    </WizardFooterWrapper>
  );
}

/* The write itself replaces the wizard, as the installer's progress page does. */
function RunView({ run, onCancel, onDone, reconnect }: { run: Run; onCancel: () => void; onDone: () => void; reconnect: boolean }) {
  const { t, msg } = useI18n();
  const working = run.kind === 'file' ? t('run.saving') : t('run.writing');
  return (
    <PageSection isFilled aria-label={working}>
      <Stack hasGutter className="step">
        <Title headingLevel="h2">{run.result ? (run.result.ok ? t('run.done') : t('run.stopped')) : working}</Title>
        {/* Twice the space between stages as between a stage's title and its bar. */}
        <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsXl' }}>
          {run.stages.map((s) => (
            <FlexItem key={s.id}>
              <Progress
                title={s.label + (s.detail ? `: ${s.detail}` : '')}
                value={s.percent ?? 0}
                // A stage with no percentage (the loader) says so in words.
                {...(s.percent === null ? { label: s.done ?? t('run.waiting'), valueText: s.done ?? t('run.waiting') } : {})}
                measureLocation={ProgressMeasureLocation.top}
                aria-label={s.label}
              />
            </FlexItem>
          ))}
        </Flex>
        {reconnect && !run.result && (
          <Alert isInline variant="info" title={t('run.reconnect.title')}
            actionLinks={<Button variant="secondary" onClick={() => { navigator.usb.requestDevice({ filters: [{ vendorId: 0x2207 }] }).catch(() => {}); }}>{t('run.reconnect.button')}</Button>}>
            {t('run.reconnect.text')}
          </Alert>
        )}
        {run.result && (
          <Alert isInline variant={run.result.ok ? (run.result.warning ? 'warning' : 'success') : 'danger'} title={msg(run.result.title)}>
            {run.result.text && <p>{run.result.text}</p>}
            {run.result.detail && <p className="detail">{run.result.detail}</p>}
          </Alert>
        )}
        <StackItem>
          {!run.result ? <Button variant="secondary" onClick={onCancel}>{t('cancel')}</Button> : (
            <ActionList>
              <ActionListGroup>
                <ActionListItem><Button variant="primary" onClick={onDone}>{run.kind === 'file' ? t('run.startOver') : t('run.another')}</Button></ActionListItem>
                {run.result.ok && run.saved && api.showSavedFile && (
                  <ActionListItem><Button variant="secondary" onClick={() => api.showSavedFile!(run.saved!)}>{t('run.showFolder')}</Button></ActionListItem>
                )}
              </ActionListGroup>
            </ActionList>
          )}
        </StackItem>
        {run.log.length > 0 && (
          <ExpandableSection toggleText={t('run.log')} className="log">
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
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  const actions = (
    <CodeBlockAction>
      <Button variant="link" className="copy-button" aria-live="polite" onClick={() => { copyText(text); setCopied(true); }}>
        {copied ? t('copied') : t('copy')}
      </Button>
    </CodeBlockAction>
  );
  return <CodeBlock actions={actions}><CodeBlockCode>{text}</CodeBlockCode></CodeBlock>;
}

/** What pressing Update will do, by how this copy was installed. Shown before anything is downloaded. */
function updatePlan(o: UpdateOffer, t: T): string {
  const file = o.asset ? `${o.asset.name} (${formatBytes(o.asset.size)})` : '';
  switch (o.kind) {
    case 'brew': return t('update.plan.brew');
    case 'dmg': return t('update.plan.dmg', { file });
    case 'windows': return t('update.plan.windows', { file });
    case 'appimage': return t('update.plan.appimage', { file });
    case 'deb': case 'rpm': return t('update.plan.pkg', { file });
    default: return '';
  }
}

/* The update itself: nothing is downloaded before the button in here is pressed. */
function UpdateModal({ offer, onClose }: { offer: UpdateOffer | null; onClose: () => void }) {
  const { t, msg } = useI18n();
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
      api.onUpdateLog?.((text) => setLog((cur) => (cur + text).slice(-20000))),
    ];
    const r = await api.installUpdate!();
    offs.forEach((off) => off?.());
    setBusy(false);
    setResult(r);
  };
  const close = () => { if (!busy) onClose(); };
  const notes = <Button variant="link" isInline component="a" href={offer.url} target="_blank">{t('releaseNotes')}</Button>;
  // Once the app itself is being replaced there is no stopping half way.
  const canCancel = stage === 'download' || stage === 'brew-update';
  const working = MESSAGES[`update.stage.${stage}`] ? t(`update.stage.${stage}`) : t('update.working');
  return (
    <Modal isOpen onClose={close} variant="small" aria-labelledby="update-title">
      <ModalHeader title={t('update.title', { version: `${offer.version}${offer.beta ? t('beta') : ''}` })} labelId="update-title" />
      <ModalBody>
        <Stack hasGutter>
          {brew && !canInstall && (
            <>
              <Content component="p">{t('update.brewManual')}</Content>
              <CopyBlock text="brew upgrade --cask roxora-imager" />
            </>
          )}
          {apt && (
            <>
              <Content component="p">{t('update.apt', { version: offer.version })}</Content>
              <CopyBlock text={APT_COMMAND} />
            </>
          )}
          {!brew && !apt && !canInstall && (
            <Content component="p">{offer.kind === 'none' ? t('update.cannot') : t('update.cannotNoPackage')}</Content>
          )}
          {canInstall && !busy && !result && <Content component="p">{updatePlan(offer, t)}</Content>}
          {busy && stage === 'download' && progress && (
            <Progress title={t('update.downloading', { name: offer.asset?.name ?? '' })} measureLocation={ProgressMeasureLocation.top}
              value={progress.total ? Math.min(100, Math.floor(progress.bytes * 100 / progress.total)) : 0}
              label={t('bytesOf', { done: formatBytes(progress.bytes), total: formatBytes(progress.total) })} />
          )}
          {busy && stage !== 'download' && (
            <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }} flexWrap={{ default: 'nowrap' }}>
              <FlexItem flex={{ default: 'flexNone' }}><Spinner size="md" aria-label={t('working')} /></FlexItem>
              <FlexItem>{working}</FlexItem>
            </Flex>
          )}
          {result && (
            <Alert isInline variant={result.ok ? 'success' : 'danger'} title={msg(result.ok ? result.message : result.reason)} />
          )}
          {result && !result.ok && result.command && <CopyBlock text={result.command} />}
          {log && (
            <ExpandableSection toggleText={t('update.output')} className="log">
              <CodeBlock><CodeBlockCode>{log}</CodeBlockCode></CodeBlock>
            </ExpandableSection>
          )}
          <StackItem>{notes}</StackItem>
        </Stack>
      </ModalBody>
      <ModalFooter>
        {canInstall && !busy && !result && <Button variant="primary" onClick={start}>{brew ? t('update.withBrew') : t('update.install')}</Button>}
        {busy && canCancel && <Button variant="secondary" onClick={() => api.cancelUpdate?.()}>{t('cancel')}</Button>}
        {result?.ok && result.restart && <Button variant="primary" onClick={() => api.restartApp?.()}>{t('update.restart')}</Button>}
        {result && !result.ok && canInstall && <Button variant="secondary" onClick={start}>{t('tryAgain')}</Button>}
        {!busy && <Button variant="link" onClick={close}>{result?.ok && result.restart ? t('update.later') : result || !canInstall ? t('close') : t('cancel')}</Button>}
      </ModalFooter>
    </Modal>
  );
}

/** The answer to "Check now", in a sentence. */
function checkWords(c: UpdateCheck, t: T, lang: Lang, msg: (m: string) => string): string {
  if (c.state === 'error') return msg(c.message);
  if (c.state === 'newer') return t('update.newer', { version: `${c.offer.version}${c.offer.beta ? t('beta') : ''}` });
  const beta = c.newerBeta ? `${gap(lang)}${t('update.newerBeta', { version: c.newerBeta })}` : '';
  return (c.beta ? t('update.betaCurrent', { version: c.version }) : t('update.current', { version: c.version })) + beta;
}

type AppSettings = { updateCheck: boolean; betaUpdates?: boolean; resetAfterMaskrom: boolean };

function SettingsModal({ open, onClose, theme, setTheme, onOffer, onUpdate, writing }: {
  open: boolean; onClose: () => void; theme: Theme; setTheme: (t: Theme) => void;
  /** A check found a newer version. */
  onOffer: (o: UpdateOffer) => void;
  /** The user wants it. */
  onUpdate: () => void;
  writing: boolean;
}) {
  const { t, lang, setLang, msg } = useI18n();
  const [s, setS] = useState<AppSettings | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { if (open) { api.getSettings().then(setS); setCheck(null); } }, [open]);
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
    <Modal isOpen={open} onClose={onClose} variant="small" aria-labelledby="settings-title">
      <ModalHeader title={t('settings')} labelId="settings-title" />
      <ModalBody>
        {s && (
          <Form onSubmit={(e) => e.preventDefault()}>
            {!WEB && (
              <FormGroup label={t('settings.updates')} fieldId="updates" role="group">
                <Stack hasGutter id="updates">
                  <Switch id="set-update" label={t('settings.updateCheck')} isChecked={s.updateCheck}
                    onChange={(_e, v) => { set({ updateCheck: v }); }} />
                  <Switch id="set-beta" label={t('settings.beta')} isChecked={s.betaUpdates === true}
                    onChange={(_e, v) => { set({ betaUpdates: v }).then(checkNow); }} />
                  <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
                    <FlexItem flex={{ default: 'flexNone' }}>
                      <Button variant="secondary" onClick={checkNow} isLoading={checking} isDisabled={checking}>{t('settings.checkNow')}</Button>
                    </FlexItem>
                    {check && <FlexItem className="update-result" aria-live="polite">{checkWords(check, t, lang, msg)}</FlexItem>}
                    {check?.state === 'newer' && (
                      <FlexItem><Button variant="link" isInline isDisabled={writing} onClick={onUpdate}>{t('settings.update')}</Button></FlexItem>
                    )}
                  </Flex>
                </Stack>
              </FormGroup>
            )}
            <Switch id="set-reset" label={t('settings.reset')} isChecked={s.resetAfterMaskrom}
              onChange={(_e, v) => { set({ resetAfterMaskrom: v }); }} />
            <FormGroup label={t('settings.appearance')} fieldId="appearance" role="group">
              <ToggleGroup aria-label={t('settings.appearance')} id="appearance">
                {(['system', 'light', 'dark'] as Theme[]).map((th) => (
                  <ToggleGroupItem key={th} text={t(`settings.theme.${th}`)} isSelected={theme === th} onChange={() => setTheme(th)} />
                ))}
              </ToggleGroup>
            </FormGroup>
            <FormGroup label={t('settings.language')} fieldId="language" role="group">
              <ToggleGroup aria-label={t('settings.language')} id="language">
                {LANGS.map((l) => (
                  <ToggleGroupItem key={l} text={<span lang={l}>{LANG_NAMES[l]}</span>} isSelected={lang === l} onChange={() => setLang(l)} />
                ))}
              </ToggleGroup>
            </FormGroup>
            <DescriptionList isCompact isHorizontal>
              <DescriptionListGroup><DescriptionListTerm>{t('settings.version')}</DescriptionListTerm><DescriptionListDescription>{api.version}</DescriptionListDescription></DescriptionListGroup>
              <DescriptionListGroup><DescriptionListTerm>{t('settings.license')}</DescriptionListTerm><DescriptionListDescription>GPL-2.0</DescriptionListDescription></DescriptionListGroup>
              <DescriptionListGroup><DescriptionListTerm>{t('settings.source')}</DescriptionListTerm><DescriptionListDescription>
                <Button variant="link" isInline component="a" href="https://github.com/roxora-os/imager" target="_blank">github.com/roxora-os/imager</Button>
              </DescriptionListDescription></DescriptionListGroup>
            </DescriptionList>
          </Form>
        )}
      </ModalBody>
      <ModalFooter><Button variant="primary" onClick={onClose}>{t('close')}</Button></ModalFooter>
    </Modal>
  );
}

export function App() {
  const { t, lang, msg } = useI18n();
  const sp = gap(lang);
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
    const timer = setInterval(look, 60 * 60 * 1000);
    return () => clearInterval(timer);
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
      setDevice((cur) => (d.targets.some((x) => x.device === cur && !x.disabled) ? cur : null));
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

  const pickRelease = async () => {
    if (!image || !api.pickReleaseFile) return;
    setFileError(null);
    setChecking({ label: t('check.release'), done: 0, total: 0 });
    const r = await api.pickReleaseFile(image.id, source === 'spi' ? 'spi' : 'image',
      (done, total) => setChecking({ label: t('check.release'), done, total }));
    setChecking(null);
    if (!r) return;
    if ('error' in r) { setReleaseFile(null); setFileError(r.error); return; }
    setReleaseFile(r);
  };
  const downloadRelease = async () => {
    if (!image || !api.downloadReleaseFile) return;
    setFileError(null);
    setChecking({ label: t('check.download'), done: 0, total: 0 });
    const r = await api.downloadReleaseFile(image.id, source === 'spi' ? 'spi' : 'image',
      (done, total) => setChecking({ label: t('check.download'), done, total }));
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
    ? t('save.short', { dir: saveTarget.dir, need: formatBytes(saveNeed), free: formatBytes(saveTarget.free) })
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

  const target = drives?.targets.find((x) => x.device === device);
  const spiProblem = method === 'maskrom' && storage === 'spinor' && source === 'file' && file
    ? spiFileProblem(file, {
      flashSize: mb?.spiFlashSize ?? SPI_FLASH_FALLBACK,
      imageFiles: catalog?.state === 'ok' ? catalog.images.map((i) => i.file) : [],
      spiFile: image?.spi?.file ?? null,
    }) : null;
  const destReady = method === 'sd' ? !!target
    : method === 'file' ? !!saveTarget && !saveShort
    : !!storage && (source === 'file' ? !!file && !spiProblem
      : source === 'spi' ? !!image?.spi && storage === 'spinor' && (!WEB || !!releaseFile)
        : !!image && !!mb?.wholeImage.includes(storage) && (!WEB || !!releaseFile));

  let why: string | null = null;
  if (sample && !custom) why = method === 'file' ? t('why.sampleSave') : t('why.sampleWrite');
  else if (!destReady) why = t('why.dest');

  const erasedWhat = method === 'file' ? '' : method === 'sd'
    ? (target ? t(target.internal ? 'erase.sdInternal' : 'erase.sd', {
      kind: target.internal ? internalText(t, target.internal) : '', desc: target.description, device: target.device, size: formatBytes(target.size),
    }) : '')
    : (storage && mb ? t('erase.maskrom', { storage: storageLabel(t, storage), board: mb.boardName }) : '');
  const saveChecks = custom ? t('checks.saveCustom')
    : `${local ? t('checks.saveLocal') : t('checks.saveDownload')}${sp}${t('checks.saveRest')}`;

  /** The progress of a drive write or a save, on the run's stages. Returns the unsubscribe. */
  const followProgress = () => api.onProgress((p: JobProgress) => {
    const id = p.stage === 'check' || p.stage === 'download' ? 'download' : p.stage;
    const pct = p.total ? Math.min(100, Math.floor(p.bytes * 100 / p.total)) : null;
    // A save of a gzip or bzip2 image does not know its size: bytes so far instead.
    const done = pct === null && p.bytes > 0 ? t('run.soFar', { bytes: formatBytes(p.bytes) }) : undefined;
    // A stage that has started means the ones before it are done.
    setRun((cur) => cur && { ...cur, stages: cur.stages.map((s) => (s.id === id ? { ...s, percent: pct, done }
      : s.id === 'download' && id !== 'download' ? { ...s, percent: 100 } : s)) });
  });

  const startSave = async () => {
    const st = saveTarget;
    if (!st || !api.saveImage || (!local && !image)) return;
    const name = local ? local.name : image!.file;
    const what: SaveSubject = local ? { localToken: local.token } : { imageId: image!.id };
    setRun({
      kind: 'file', log: [], result: null, saved: st.token,
      stages: [
        ...(custom ? [] : [{ id: 'download', percent: 0, label: local ? t('stage.checkFile') : t('stage.download') }]),
        { id: 'write', percent: 0, label: t(uncompressedName(name) === name ? 'stage.save' : 'stage.decompressSave', { file: fileName(st.path) })
          + (custom ? '' : t('stage.andCompare')) },
      ],
    });
    const off = followProgress();
    // As in startSd: never leave a run without a result.
    let res: Awaited<ReturnType<NonNullable<typeof api.saveImage>>>;
    try {
      res = await api.saveImage(what, st.token);
    } catch (e) {
      res = { ok: false, reason: t('run.errorSave'), detail: String((e as Error)?.message ?? e) };
    } finally {
      off();
    }
    setRun((cur) => cur && {
      ...cur,
      // A bar that counted bytes without a total ends full.
      stages: res.ok ? cur.stages.map((s) => ({ ...s, percent: 100, done: undefined })) : cur.stages,
      result: res.ok
        // The SHA-256 on a line of its own, in the detail style: a path and a hash in one sentence wrap badly.
        ? { ok: true, title: custom ? t('result.saved') : t('result.savedChecked'), detail: `SHA-256 ${res.sha256}`,
          text: t(custom ? 'result.savedCustom' : 'result.savedRelease', { path: st.path, name }) }
        : { ok: false, title: res.reason, text: /Nothing was saved/.test(res.reason) ? '' : t('result.nothingSaved'),
          ...(res.detail ? { detail: res.detail } : {}) },
    });
  };

  const startSd = async () => {
    if (!target || (!local && !image)) return;
    const name = local ? local.name : image!.file;
    const r: Run = {
      kind: 'sd', log: [], result: null,
      stages: [
        { id: 'download', percent: 0, label: custom ? t('stage.readHash')
          : local ? t('stage.checkFile') : t('stage.download') },
        { id: 'write', label: t('stage.write', { device: target.device }), percent: 0 },
        { id: 'verify', label: custom ? t('stage.verifyImage') : t('stage.verifyRelease'), percent: 0 },
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
      res = { ok: false, reason: t('run.errorWrite'), detail: String((e as Error)?.message ?? e) } as typeof res;
    } finally {
      off();
    }
    setRun((cur) => cur && {
      ...cur,
      result: res.ok
        ? { ok: true, title: t('result.written'), text: t(custom ? 'result.sdCustom' : 'result.sdRelease', { drive: target.description, name, sha: res.sha256 }) }
        : { ok: false, title: res.reason, text: /Nothing was written/.test(res.reason) ? '' : t('result.partly'), ...(res.detail ? { detail: res.detail } : {}) },
    });
  };

  const startMaskromWrite = async () => {
    if (!storage || !mb) return;
    const st = STORAGES[storage];
    const stLabel = storageLabel(t, storage);
    const r: Run = {
      kind: 'maskrom', log: [], result: null,
      stages: [
        { id: 'prepare', label: source === 'release' ? t('stage.prepRelease') : source === 'spi' ? t('stage.download') : t('stage.prepFile'), percent: 0 },
        { id: 'loader', label: t('stage.loader'), percent: null },
        { id: 'write', label: t('stage.write', { device: stLabel }), percent: 0 },
        { id: 'verify', label: t('stage.verify'), percent: 0 },
      ],
    };
    setRun(r);
    const setStage = (id: string, patch: Partial<Run['stages'][number]>) =>
      setRun((cur) => cur && { ...cur, stages: cur.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
    const finish = (result: Run['result']) => setRun((cur) => cur && { ...cur, result });

    let prepared = source === 'file' ? file : WEB ? releaseFile : null;
    if (!WEB && (source === 'release' || source === 'spi') && image) {
      const off = api.onProgress((p) => setStage('prepare', { percent: p.total ? Math.min(100, Math.floor(p.bytes * 100 / p.total)) : null, detail: t(`progress.${p.stage}`) }));
      const res = await api.prepareMaskrom(image.id, source === 'spi' ? 'spi' : 'image');
      off();
      if ('error' in res) { finish({ ok: false, title: res.error, text: t('result.nothingWritten') }); return; }
      prepared = res;
    }
    if (!prepared) return;
    setStage('prepare', { percent: 100, detail: undefined });
    // Rockchip's loader is not shipped: built from rkbin on first use.
    setStage('loader', { percent: null, detail: t('stage.gettingLoader') });
    const loader = await api.getLoader(mb.loader);
    if ('error' in loader) {
      if (source !== 'file') api.releaseMaskrom(prepared.token);
      finish({ ok: false, title: loader.error, text: t('result.nothingWritten') });
      return;
    }
    setStage('loader', { percent: null, detail: undefined });
    const settingsNow = await api.getSettings();
    const job = startMaskrom({
      loaderUrl: loader.url, size: prepared.size, sha256: prepared.sha256,
      ...(prepared.file ? { file: prepared.file, reconnectTimeout: 180000 } : { fileUrl: prepared.url }),
      storageCode: st.code, storageLabel: st.label, verify: true, resetAfter: settingsNow.resetAfterMaskrom,
    }, {
      log: (line) => setRun((cur) => cur && { ...cur, log: [...cur.log, line] }),
      stage: (s: Stage) => {
        if (s === 'loader' || s === 'reconnect') setStage('loader', { percent: null, detail: s === 'reconnect' ? t('stage.waitingBoard') : undefined });
        // A browser forgets the board when it restarts in Loader mode; it has
        // to be chosen again (the desktop app finds it by itself).
        if (s === 'reconnect' && WEB) setReconnect(true);
        if (s === 'storage') { setReconnect(false); setStage('loader', { percent: 100, detail: undefined }); }
      },
      progress: (s, pct) => { if (s === 'write' || s === 'verify') setStage(s, { percent: pct }); },
    });
    maskromJob.current = job;
    let res: Awaited<typeof job.done>;
    try {
      res = await job.done;
    } catch (e) {
      // As in startSd: never leave a run without a result.
      res = { ok: false, reason: t('run.errorWrite'), detail: String((e as Error)?.message ?? e) };
    }
    maskromJob.current = null;
    setReconnect(false);
    if (source !== 'file') api.releaseMaskrom(prepared.token);
    const restarting = settingsNow.resetAfterMaskrom ? `${sp}${t('result.restarting')}` : '';
    const mib = (n: number) => `${Math.floor(n / 1048576)} MiB`;
    const said = { name: prepared.name, storage: stLabel };
    finish(!res.ok
      ? { ok: false, title: res.reason, text: t('result.checkConnection'), ...(res.detail ? { detail: res.detail } : {}) }
      : res.verified === 'match'
        ? { ok: true, title: t('result.written'), text: t('result.mrMatch', { ...said, sha: res.sha256 }) + restarting }
        : res.verified === 'partial'
          ? { ok: true, warning: true, title: t('result.mrPartialTitle', { mib: mib(res.verifiedBytes) }),
            text: t('result.mrPartial', { ...said, mib: mib(res.verifiedBytes) }) + restarting }
          : { ok: true, warning: true, title: t('result.mrUnverifiedTitle'), text: t('result.mrUnverified', said) + restarting });
  };

  // A save erases nothing, so it needs no second question.
  const onWrite = () => { if (method === 'file') startSave(); else setConfirm(true); };
  const doWrite = () => {
    setConfirm(false);
    if (method === 'sd') { startSd(); return; }
    if (WEB) {
      // WebUSB only shows devices the user picked; this click is the gesture.
      navigator.usb.requestDevice({ filters: [{ vendorId: 0x2207 }] })
        .then(() => startMaskromWrite(), () => setFileError(t('why.noBoardChosen')));
      return;
    }
    startMaskromWrite();
  };
  const cancel = () => {
    if (maskromJob.current) maskromJob.current.cancel();
    else api.cancel();
  };

  const finishRun = () => { setRun(null); setDevice(null); setSaveTarget(null); };

  // Notices about the whole app sit under the first step's title. The ones
  // that stop a write (sample data, no WebUSB) show again on the review.
  const noUsb = WEB && !('usb' in navigator) && (
    <Alert isInline variant="warning" title={t('web.noUsb.title')}>
      {t('web.noUsb.text')}{' '}
      <Button variant="link" isInline component="a" href={DESKTOP_URL} target="_blank">{t('web.desktopApp')}</Button>{t('dest.web.end')}
    </Alert>
  );
  const sampleNote = sample && (
    <Alert isInline variant="warning" title={t('sample.title')}
      actionLinks={<Button variant="link" isInline onClick={() => setUseSample(false)}>{t('sample.load')}</Button>}>
      {t('sample.text')}
    </Alert>
  );
  const notices = (
    <>
      {noUsb}
      {sampleNote}
    </>
  );
  const writeNotices = <>{noUsb}{sampleNote}</>;
  // PatternFly's wizard buttons say Next and Back in English unless told.
  const stepButtons = { nextButtonText: t('next'), backButtonText: t('back') };

  return (
    <Shell onSettings={() => setSettings(true)}>
      {/* A newer version: above the wizard, never during a write. */}
      {!run && offer && dismissed !== offer.version && (
        <PageSection aria-label={t('update.region')} className="update-notice">
          <Alert isInline variant="info" title={t('update.available', { version: `${offer.version}${offer.beta ? t('beta') : ''}` })}
            actionClose={<AlertActionCloseButton onClose={() => dismissUpdate(offer.version)} />}
            actionLinks={(
              <>
                <AlertActionLink onClick={() => setUpdating(true)}>{t('settings.update')}</AlertActionLink>
                <AlertActionLink component="a" href={offer.url} target="_blank">{t('releaseNotes')}</AlertActionLink>
              </>
            )}>
            {offer.notes}
          </Alert>
        </PageSection>
      )}
      {run ? <RunView run={run} onCancel={cancel} onDone={finishRun} reconnect={reconnect} /> : (
        <PageSection type="wizard" isFilled hasBodyWrapper={false} aria-label={t('wizard.label')}>
          <Wizard navAriaLabel={t('wizard.steps')} isVisitRequired header={<Jump to={jump} done={() => setJump(null)} />} onStepChange={(_e, step) => { if (step.id === 'dest' && method === 'sd') refreshDrives(); }}>
            <WizardStep name={t('step.board')} id="board" footer={{ ...stepButtons, isNextDisabled: !board && !local, isCancelHidden: true }}>
              {/* Choosing a board means choosing among its release images: a custom file goes. */}
              <BoardStep catalog={catalog} boards={boards} board={board} reload={load}
                setBoard={(b) => { if (b !== board) setLocal(null); chooseBoard(b); }}
                find={{ query, setQuery, vendor, setVendor }} notices={notices} lp={lp} />
            </WizardStep>
            <WizardStep name={t('step.image')} id="image" isDisabled={!board && !local} footer={{ ...stepButtons, isNextDisabled: !imageId && !local, isCancelHidden: true }}>
              <ImageStep board={cur} imageId={imageId} setImage={(id) => { setLocal(null); setImageId(id); }} lp={lp} />
            </WizardStep>
            <WizardStep name={t('step.dest')} id="dest" isDisabled={!imageId && !local} footer={{ ...stepButtons, isNextDisabled: !destReady, isCancelHidden: true, nextButtonText: t('step.review') }}>
              <DestinationStep boardName={cur?.boardName ?? ''} boardId={board ?? ''} image={image}
                method={method} setMethod={(m) => { setMethod(m); if (m === 'sd') refreshDrives(); }}
                drives={drives} refreshDrives={refreshDrives} device={device} setDevice={chooseDevice}
                showInternal={internalSwitch ? showInternal : null} setShowInternal={toggleInternal}
                storage={storage} setStorage={(s) => { setStorage(s); setSource(mb?.wholeImage.includes(s) ? 'release' : s === 'spinor' && image?.spi ? 'spi' : 'file'); }}
                source={source} setSource={setSource} file={file} pickFile={pickFile} picking={picking} fileError={fileError}
                releaseFile={releaseFile} pickRelease={pickRelease} checking={checking}
                downloadRelease={downloadRelease} proxyError={proxyError} custom={custom} spiProblem={spiProblem}
                saveTarget={saveTarget} pickSave={pickSave} savePicking={savePicking} saveError={saveError ?? saveShort} />
            </WizardStep>
            <WizardStep name={t('step.review')} id="review" isDisabled={!destReady}
              footer={<ReviewFooter canWrite={!why} why={why} onWrite={onWrite} save={method === 'file'} />}>
              <StepPage title={t('step.review')} notices={writeNotices}
                lead={method === 'file' ? t('review.leadSave') : t('review.leadWrite')}>
                {erasedWhat && <Alert isInline variant="danger" title={t('erase.will', { what: erasedWhat })} />}
              <DescriptionList isHorizontal>
                {!custom && <DescriptionListGroup><DescriptionListTerm>{t('review.board')}</DescriptionListTerm><DescriptionListDescription>{cur?.boardName}</DescriptionListDescription></DescriptionListGroup>}
                {custom && local && (
                  <>
                    <DescriptionListGroup><DescriptionListTerm>{t('review.image')}</DescriptionListTerm><DescriptionListDescription>{t('review.localImage', { name: local.name, size: formatBytes(local.size) })}</DescriptionListDescription></DescriptionListGroup>
                    <DescriptionListGroup><DescriptionListTerm>{t('review.release')}</DescriptionListTerm><DescriptionListDescription>{t('review.notRelease')}</DescriptionListDescription></DescriptionListGroup>
                  </>
                )}
                {!custom && (method !== 'maskrom' || source === 'release') && image && (
                  <>
                    <DescriptionListGroup><DescriptionListTerm>{t('review.image')}</DescriptionListTerm><DescriptionListDescription>{image.file}</DescriptionListDescription></DescriptionListGroup>
                    <DescriptionListGroup><DescriptionListTerm>{t('review.release')}</DescriptionListTerm><DescriptionListDescription>{t('pair', { a: releaseWords(t, image), b: image.releaseInfo.date })}</DescriptionListDescription></DescriptionListGroup>
                  </>
                )}
                {method !== 'maskrom' && local?.imageId && (
                  <DescriptionListGroup><DescriptionListTerm>{t('review.file')}</DescriptionListTerm><DescriptionListDescription>{t('review.localMatch', { name: local.name })}</DescriptionListDescription></DescriptionListGroup>
                )}
                {method === 'maskrom' && source === 'spi' && image?.spi && (
                  <DescriptionListGroup><DescriptionListTerm>{t('review.spi')}</DescriptionListTerm><DescriptionListDescription>{t('review.spiFile', {
                    file: image.spi.file, size: formatBytes(image.spi.size), release: lang === 'en' ? releaseWords(t, image).toLowerCase() : releaseWords(t, image),
                  })}</DescriptionListDescription></DescriptionListGroup>
                )}
                {WEB && source !== 'file' && releaseFile && (
                  <DescriptionListGroup><DescriptionListTerm>{t('review.releaseFile')}</DescriptionListTerm><DescriptionListDescription>{t('review.releaseFileMatch', { name: releaseFile.name })}</DescriptionListDescription></DescriptionListGroup>
                )}
                {method === 'maskrom' && source === 'file' && file && (
                  <DescriptionListGroup><DescriptionListTerm>{t('review.file')}</DescriptionListTerm><DescriptionListDescription>{t('pair', { a: file.name, b: formatBytes(file.size) })}</DescriptionListDescription></DescriptionListGroup>
                )}
                <DescriptionListGroup><DescriptionListTerm>{t('review.dest')}</DescriptionListTerm><DescriptionListDescription>
                  {method === 'sd' ? (target ? t('review.destSd', { desc: target.description, device: target.device, size: formatBytes(target.size) }) : '')
                    : method === 'file' ? (saveTarget ? (saveNeed ? t('pair', { a: saveTarget.path, b: formatBytes(saveNeed) }) : saveTarget.path) : '')
                    : (storage ? t('review.destMaskrom', { storage: storageLabel(t, storage) }) : '')}
                </DescriptionListDescription></DescriptionListGroup>
                {method === 'file' && (
                  <DescriptionListGroup><DescriptionListTerm>{t('review.boots')}</DescriptionListTerm><DescriptionListDescription>{bootNote(t, image, custom)}</DescriptionListDescription></DescriptionListGroup>
                )}
                <DescriptionListGroup><DescriptionListTerm>{t('review.checks')}</DescriptionListTerm><DescriptionListDescription>
                  {method === 'file' ? saveChecks
                    : custom ? t('checks.custom')
                    : method === 'sd' && local ? t('checks.sdLocal')
                    : method === 'sd' || source === 'release' || source === 'spi'
                    ? t('checks.release')
                    : t('checks.file')}
                </DescriptionListDescription></DescriptionListGroup>
              </DescriptionList>
              </StepPage>
            </WizardStep>
          </Wizard>
        </PageSection>
      )}

      <Modal isOpen={!!askInternal} onClose={() => setAskInternal(null)} variant="small" aria-labelledby="internal-title">
        <ModalHeader title={t('internal.title')} labelId="internal-title" titleIconVariant="warning" />
        {askInternal && askInternal.internal && (
          <ModalBody>
            {t('internal.body', {
              device: askInternal.device, kind: internalText(t, askInternal.internal),
              details: askInternal.description ? t('pair', { a: askInternal.description, b: formatBytes(askInternal.size) }) : formatBytes(askInternal.size),
            })}
          </ModalBody>
        )}
        <ModalFooter>
          <Button variant="danger" onClick={() => { if (askInternal) setDevice(askInternal.device); setAskInternal(null); }}>
            {t('internal.use', { device: askInternal?.device ?? t('internal.thisDisk') })}
          </Button>
          <Button variant="link" onClick={() => setAskInternal(null)}>{t('cancel')}</Button>
        </ModalFooter>
      </Modal>

      <Modal isOpen={confirm} onClose={() => setConfirm(false)} variant="small" aria-labelledby="confirm-title">
        <ModalHeader title={t('confirm.title')} labelId="confirm-title" titleIconVariant="warning" />
        <ModalBody>{erasedWhat ? t('confirm.body', { what: erasedWhat }) : ''}</ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={doWrite}>{t('eraseWrite')}</Button>
          <Button variant="link" onClick={() => setConfirm(false)}>{t('cancel')}</Button>
        </ModalFooter>
      </Modal>

      <Modal isOpen={!!usbChoices} onClose={() => { api.answerUsbChoice(''); setUsbChoices(null); }} variant="small" aria-labelledby="usb-title">
        <ModalHeader title={t('usb.title')} labelId="usb-title" />
        <ModalBody>
          <Stack hasGutter>
            <Content component="p">{t('usb.text')}</Content>
            {usbChoices?.map((c) => (
              <StackItem key={c.deviceId}>
                <Button variant="secondary" onClick={() => { api.answerUsbChoice(c.deviceId); setUsbChoices(null); }}>
                  {t('usb.product', { name: c.productName || t('usb.device'), id: c.productId.toString(16) })}
                </Button>
              </StackItem>
            ))}
          </Stack>
        </ModalBody>
      </Modal>

      <SettingsModal open={settings} onClose={() => setSettings(false)} theme={theme} setTheme={setTheme}
        onOffer={setOffer} onUpdate={() => { setSettings(false); setUpdating(true); }} writing={!!run && !run.result} />
      <UpdateModal offer={updating && !(run && !run.result) ? offer : null} onClose={() => setUpdating(false)} />
    </Shell>
  );
}
