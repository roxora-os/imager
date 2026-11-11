import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionList, ActionListGroup, ActionListItem, Alert, Button, CodeBlock, CodeBlockCode, Content, DescriptionList,
  DescriptionListDescription, DescriptionListGroup, DescriptionListTerm, EmptyState, EmptyStateActions, EmptyStateBody,
  EmptyStateFooter, ExpandableSection, Flex, FlexItem, Form, FormGroup, FormSelect, FormSelectOption, Masthead,
  MastheadBrand, MastheadContent, MastheadLogo, MastheadMain, Modal, ModalBody, ModalFooter, ModalHeader, Page,
  PageSection, Progress, ProgressMeasureLocation, Radio, SearchInput, Sidebar, SidebarContent, SidebarPanel, SimpleList,
  SimpleListItem,
  Spinner, Stack, StackItem, Switch, Title, ToggleGroup, ToggleGroupItem, Toolbar, ToolbarContent, ToolbarGroup,
  ToolbarItem, Wizard, WizardFooterWrapper, WizardStep,
  useWizardContext,
} from '@patternfly/react-core';
import { CogIcon } from '@patternfly/react-icons/dist/esm/icons/cog-icon';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { groupByBoard, type Board, type CatalogImage } from '../shared/catalog';
import { BOARD_REQUEST_URL, queryWords, vendorCounts, visibleBoards } from '../shared/boardsearch';
import { formatBytes, statusWords } from '../shared/format';
import type { CatalogResult, ImagerApi, JobProgress, PreparedFile } from '../shared/ipc';
import type { HiddenDrive, Target } from '../shared/targets';
import { maskromBoard, STORAGES, type StorageId } from '../maskrom/boards';
import { RKBIN_HOST } from '../maskrom/loaders';
import type { Stage } from '../maskrom/sequence';
import { startMaskrom, type MaskromJob } from './maskrom-client';
import { readTheme, applyTheme, type Theme } from './theme';

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
const LOADER_NOTE = `The first Maskrom write downloads Rockchip's loader from ${RKBIN_HOST} (rockchip-linux/rkbin) and checks it.`;

type Method = 'sd' | 'maskrom';
type MaskromSource = 'release' | 'spi' | 'file';
/** A release file being downloaded or checked: what, and how far. */
interface Checking { label: string; done: number; total: number }

interface Run {
  kind: Method;
  stages: { id: string; label: string; percent: number | null; detail?: string }[];
  log: string[];
  result: { ok: boolean; title: string; text: string; detail?: string } | null;
}

const RELEASES_URL = 'https://github.com/roxora-os/build/releases';

/** What a Maskrom write takes by default: the whole image where it fits, else the release's SPI bootloader, else a file. */
function defaultSource(m: ReturnType<typeof maskromBoard>, img: CatalogImage | undefined): MaskromSource {
  if (m?.imageStorage) return 'release';
  if (img?.spi && m?.storages.includes('spinor')) return 'spi';
  return 'file';
}

function releaseWords(img: CatalogImage): string {
  return img.releaseInfo.prerelease ? `Pre-release ${img.releaseInfo.version}` : `Release ${img.releaseInfo.version}`;
}

/*
 * The page shell, laid out as Fedora's installer (anaconda-webui) does it:
 * a masthead, then one wizard that fills the rest of the window, its step
 * nav running the full height and its footer pinned to the bottom.
 */
function Shell({ children, onSettings }: { children: React.ReactNode; onSettings: () => void }) {
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
                <Button variant="plain" icon={<CogIcon />} onClick={onSettings}>Settings</Button>
              </ToolbarItem>
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );
  return <Page masthead={masthead} isContentFilled>{children}</Page>;
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

interface FindState { query: string; setQuery: (q: string) => void; vendor: string; setVendor: (v: string) => void }

function BoardStep({ catalog, boards, board, setBoard, reload, find, notices }: {
  catalog: CatalogResult | null; boards: Board[]; board: string | null;
  setBoard: (b: string) => void; reload: () => void; find: FindState; notices: React.ReactNode;
}) {
  if (!catalog) return <EmptyState titleText="Loading releases" headingLevel="h2" icon={Spinner} />;
  if (catalog.state === 'error') {
    return (
      <EmptyState titleText="Could not load the releases" headingLevel="h2">
        <EmptyStateBody>{catalog.message}</EmptyStateBody>
        <EmptyStateFooter><Button variant="secondary" onClick={reload}>Try again</Button></EmptyStateFooter>
      </EmptyState>
    );
  }
  if (catalog.state === 'none') {
    return (
      <EmptyState titleText="No Roxora releases yet" headingLevel="h2">
        <EmptyStateBody>
          Roxora images are published as releases of roxora-os/build. There are none yet, so there is nothing to
          write. This list fills itself once the first release is out.
        </EmptyStateBody>
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="secondary" onClick={reload}>Check again</Button>
            <Button variant="link" component="a" href={RELEASES_URL} target="_blank">Releases on GitHub</Button>
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  }
  return (
    <StepPage title="Board" lead="Choose the board you want to install Roxora on." notices={notices}>
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
        <SearchInput placeholder="Search boards, vendors or SoCs" value={query} aria-label="Search boards, vendors or SoCs"
          onChange={(_e, v) => setQuery(v)} onClear={() => setQuery('')} />
      </div>
      <Sidebar hasGutter>
        <SidebarPanel width={{ default: 'width_25' }}>
          <div className="vendor-select">
            <FormSelect value={active} onChange={(_e, v) => pick(v)} aria-label="Vendor">
              <FormSelectOption value={ALL} label={vendorLabel('All vendors', total)} />
              {counts.map((c) => (
                <FormSelectOption key={c.vendor} value={c.vendor} label={vendorLabel(c.vendor, c.count)} isDisabled={searching && c.count === 0} />
              ))}
            </FormSelect>
          </div>
          <nav className="vendor-list" aria-label="Vendors">
            <SimpleList onSelect={(_ref, props) => pick(String(props.itemId ?? ALL))} isControlled={false}>
              {vendorItem(ALL, 'All vendors', total)}
              {counts.map((c) => vendorItem(c.vendor, c.vendor, c.count, searching && c.count === 0))}
            </SimpleList>
          </nav>
        </SidebarPanel>
        <SidebarContent>
          {shown.length === 0 ? (
            <EmptyState titleText={<>No board matches &ldquo;{query.trim()}&rdquo;</>} headingLevel="h3" variant="sm">
              <EmptyStateFooter>
                <EmptyStateActions>
                  <Button variant="link" component="a" href={BOARD_REQUEST_URL} target="_blank">Ask for a board to be supported</Button>
                  <Button variant="link" onClick={() => setQuery('')}>Clear the search</Button>
                </EmptyStateActions>
              </EmptyStateFooter>
            </EmptyState>
          ) : (
            <Table aria-label="Boards" variant="compact">
              <Thead><Tr><Th screenReaderText="Select" /><Th>Board</Th><Th>SoC</Th><Th>Newest image</Th></Tr></Thead>
              <Tbody>
                {shown.map((b, i) => (
                  <Tr key={b.board} isClickable onRowClick={() => setBoard(b.board)} isRowSelected={board === b.board}>
                    <Td select={{ rowIndex: i, variant: 'radio', isSelected: board === b.board, onSelect: () => setBoard(b.board) }} />
                    <Td dataLabel="Board" className="nowrap-md">{b.boardName}</Td>
                    <Td dataLabel="SoC" className="nowrap-md">{b.soc.toUpperCase()}</Td>
                    <Td dataLabel="Newest image">{releaseWords(b.images[0])}, {b.images[0].status === 'hardware-tested' ? 'tested on hardware' : 'not yet tested on hardware'}</Td>
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

function ImageStep({ board, imageId, setImage }: {
  board: Board | undefined; imageId: string | null; setImage: (id: string) => void;
}) {
  if (!board) return null;
  const sel = board.images.find((i) => i.id === imageId);
  return (
    <StepPage title="Image" lead={`Images for ${board.boardName}, newest first.`} >
      <Table aria-label="Images" variant="compact">
        <Thead><Tr><Th screenReaderText="Select" /><Th>Release</Th><Th>Ubuntu</Th><Th>Kernel</Th><Th>Download</Th><Th>Status</Th></Tr></Thead>
        <Tbody>
          {board.images.map((img, i) => (
            <Tr key={img.id} isClickable onRowClick={() => setImage(img.id)} isRowSelected={imageId === img.id}>
              <Td select={{ rowIndex: i, variant: 'radio', isSelected: imageId === img.id, onSelect: () => setImage(img.id) }} />
              <Td dataLabel="Release">{releaseWords(img)}<div className="muted">{img.releaseInfo.date}</div></Td>
              <Td dataLabel="Ubuntu">{img.ubuntuVersion} ({img.release})</Td>
              <Td dataLabel="Kernel">{img.kernel ? `${img.kernel} ` : ''}{img.branch}</Td>
              <Td dataLabel="Download">{formatBytes(img.size)}</Td>
              <Td dataLabel="Status">{img.status === 'hardware-tested' ? 'Tested on hardware' : 'CI only'}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
      {sel && (
        <Content component="p" className="step-lead">
          {statusWords(sel.status)}. {sel.releaseInfo.prerelease
            ? 'Pre-releases have not been through the full hardware test.' : ''}{' '}
          <Button variant="link" isInline component="a" href={sel.releaseInfo.url} target="_blank">Release notes</Button>
        </Content>
      )}
    </StepPage>
  );
}

function DriversNote() {
  if (WEB) {
    return (
      <Content component="p">
        On Windows the board needs the WinUSB driver: install it once
        with <Button variant="link" isInline component="a" href="https://zadig.akeo.ie/" target="_blank">Zadig</Button> (the
        device with ID 2207, WinUSB, Install Driver). On Linux your user needs access to the device, for example
        through a udev rule for vendor 2207 with TAG+="uaccess". macOS needs nothing.
      </Content>
    );
  }
  if (api.platform === 'win32') {
    return (
      <Content component="p">
        Windows needs the WinUSB driver for the board in Maskrom mode. Install it once with Zadig: choose the
        device with ID 2207 in Zadig's list, select WinUSB and click Install Driver.{' '}
        <Button variant="link" isInline component="a" href="https://zadig.akeo.ie/" target="_blank">zadig.akeo.ie</Button>
      </Content>
    );
  }
  if (api.platform === 'linux') {
    return (
      <>
        <Content component="p">
          The .deb and .rpm packages install a udev rule that lets you use the board without root. With the
          AppImage, add the rule once:
        </Content>
        <CodeBlock><CodeBlockCode>{'echo \'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/70-roxora-imager.rules\nsudo udevadm control --reload-rules && sudo udevadm trigger'}</CodeBlockCode></CodeBlock>
      </>
    );
  }
  return <Content component="p">macOS needs no driver.</Content>;
}

function DestinationStep(p: {
  boardName: string; boardId: string; image: CatalogImage | undefined;
  method: Method; setMethod: (m: Method) => void;
  drives: { targets: Target[]; hidden: HiddenDrive[] } | null; refreshDrives: () => void;
  device: string | null; setDevice: (d: string) => void;
  storage: StorageId | null; setStorage: (s: StorageId) => void;
  source: MaskromSource; setSource: (s: MaskromSource) => void;
  file: PreparedFile | null; pickFile: () => void; picking: boolean; fileError: string | null;
  releaseFile: PreparedFile | null; pickRelease: () => void; checking: Checking | null;
  downloadRelease: () => void; proxyError: string | null;
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
  const viaProxy = WEB && !!api.downloadProxy && !p.proxyError;
  const releaseKind = WEB && mb && (p.source === 'spi' ? 'spi' : p.source === 'release' ? 'image' : null);
  const relFile = releaseKind === 'spi' ? p.image?.spi : releaseKind === 'image' ? p.image : undefined;
  const releasePicker = (what: 'image' | 'spi') => {
    if (releaseKind !== what) return undefined;
    if (p.checking) {
      return (
        <Progress size="sm" title={p.checking.label} measureLocation={ProgressMeasureLocation.top}
          value={p.checking.total ? Math.floor(p.checking.done * 100 / p.checking.total) : 0}
          label={p.checking.total ? `${formatBytes(p.checking.done)} of ${formatBytes(p.checking.total)}` : undefined} />
      );
    }
    if (viaProxy) {
      return fileRow(
        <Button variant="secondary" onClick={p.downloadRelease}>Download from the release</Button>,
        p.releaseFile ? `${p.releaseFile.name}: downloaded, matches the release`
          : relFile ? `${relFile.file}, ${formatBytes(relFile.size)}, through ${api.downloadProxy}` : '',
      );
    }
    return fileRow(
      <Button variant="secondary" onClick={p.pickRelease}>Choose the downloaded file</Button>,
      p.releaseFile ? `${p.releaseFile.name}: matches the release` : 'No file chosen',
    );
  };
  // When the proxy download fails the reason is up under the title: bring it into view.
  const byHandRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (p.proxyError) byHandRef.current?.scrollIntoView({ block: 'nearest' }); }, [p.proxyError]);
  const byHand = !!relFile && !viaProxy && !p.releaseFile && (
    <Alert ref={byHandRef} isInline variant={p.proxyError ? 'warning' : 'info'} title="Download the release file by hand">
      {p.proxyError ?? 'GitHub does not let a web page download release files itself.'} Download it, then
      choose it under What to write:{' '}
      <Button variant="link" isInline component="a" href={relFile.url}>{relFile.file}</Button>
    </Alert>
  );
  const lead = WEB ? (
    <>
      A browser cannot write an SD card or USB drive in this computer; for that use
      the <Button variant="link" isInline component="a" href={DESKTOP_URL} target="_blank">Roxora Imager desktop app</Button> or <Button variant="link" isInline component="a" href={RPI_IMAGER_URL} target="_blank">Raspberry Pi Imager</Button>.
      {mb ? ` Here the ${p.boardName} is written over USB in Maskrom mode. ${LOADER_NOTE}` : ` Maskrom writing is not set up for ${p.boardName}.`}
    </>
  ) : undefined;
  return (
    <StepPage title="Destination" lead={lead} notices={byHand || undefined}>
      <Form className="destination" onSubmit={(e) => e.preventDefault()}>
        {!WEB && (
          <FormGroup role="radiogroup" fieldId="method" label="Write to" isStack>
            <Radio id="method-sd" name="method" isChecked={p.method === 'sd'} onChange={() => p.setMethod('sd')}
              label="SD card or USB drive" description="Write the image to a card or stick in this computer, then boot the board from it." />
            <Radio id="method-maskrom" name="method" isChecked={p.method === 'maskrom'} onChange={() => p.setMethod('maskrom')}
              isDisabled={!mb}
              label="Board storage over USB (Maskrom)"
              description={mb ? `Through the board's USB-C port: ${mb.storages.map((s) => STORAGES[s].label).join(', or ')}. ${LOADER_NOTE}`
                : `Maskrom writing is not set up for ${p.boardName}.`} />
          </FormGroup>
        )}

        {p.method === 'sd' && (
          <FormGroup fieldId="drives" label="Drive"
            labelInfo={<Button variant="link" isInline onClick={p.refreshDrives}>Refresh</Button>}>
            {!p.drives ? <Spinner size="md" aria-label="Looking for drives" /> : p.drives.targets.length === 0 ? (
              <Content component="p">No SD card or USB drive found. Insert one and click Refresh.</Content>
            ) : (
              <Table aria-label="Drives" variant="compact" id="drives">
                <Thead><Tr><Th screenReaderText="Select" /><Th>Drive</Th><Th>Device</Th><Th>Size</Th></Tr></Thead>
                <Tbody>
                  {p.drives.targets.map((t, i) => (
                    <Tr key={t.device} isClickable={!t.disabled} onRowClick={() => !t.disabled && p.setDevice(t.device)} isRowSelected={p.device === t.device}>
                      <Td select={{ rowIndex: i, variant: 'radio', isSelected: p.device === t.device, isDisabled: !!t.disabled, onSelect: () => p.setDevice(t.device) }} />
                      <Td dataLabel="Drive">
                        {t.description}
                        {t.disabled && <div className="muted">{t.disabled}</div>}
                        {t.warning && !t.disabled && <div className="muted">{t.warning}</div>}
                      </Td>
                      <Td dataLabel="Device">{t.device}</Td>
                      <Td dataLabel="Size">{formatBytes(t.size)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
            {p.drives && p.drives.hidden.length > 0 && (
              <ExpandableSection toggleText={`${p.drives.hidden.length} ${p.drives.hidden.length === 1 ? 'drive is' : 'drives are'} not offered`}>
                <Content component="ul">{p.drives.hidden.map((h) => <li key={h.device}>{h.device} {h.description}: {h.reason}</li>)}</Content>
              </ExpandableSection>
            )}
          </FormGroup>
        )}

        {p.method === 'maskrom' && mb && (
          <>
            <FormGroup role="radiogroup" fieldId="storage" label="Storage" isStack>
              {mb.storages.map((s) => (
                <Radio key={s} id={`storage-${s}`} name="storage" isChecked={p.storage === s} onChange={() => p.setStorage(s)}
                  label={STORAGES[s].label} description={STORAGES[s].note} />
              ))}
            </FormGroup>
            <FormGroup role="radiogroup" fieldId="source" label="What to write" isStack>
              <Radio id="src-release" name="source" isChecked={p.source === 'release'} onChange={() => p.setSource('release')}
                isDisabled={!p.storage || !mb.wholeImage.includes(p.storage)}
                label={p.image ? `The image chosen in the previous step (${p.image.file})` : 'The image chosen in the previous step'}
                description={p.storage && mb.wholeImage.includes(p.storage) ? undefined
                  : mb.imageNote ?? `A whole image goes to ${mb.wholeImage.map((s) => STORAGES[s].label).join(' or ')}.`}
                body={releasePicker('image')} />
              {mb.storages.includes('spinor') && (
                <Radio id="src-spi" name="source" isChecked={p.source === 'spi'} onChange={() => p.setSource('spi')}
                  isDisabled={!p.image?.spi || p.storage !== 'spinor'}
                  label={p.image?.spi ? `This release's SPI bootloader (${p.image.spi.file}, ${formatBytes(p.image.spi.size)})` : "This release's SPI bootloader"}
                  description={!p.image?.spi ? 'This release has no SPI bootloader for the board.'
                    : viaProxy ? 'Downloaded from the release and checked against its SHA-256, then read back after writing.'
                    : WEB ? 'Checked against the release SHA-256 when you choose it, then read back after writing.'
                      : 'Downloaded from the release and checked against its SHA-256, then read back after writing.'}
                  body={releasePicker('spi')} />
              )}
              <Radio id="src-file" name="source" isChecked={p.source === 'file'} onChange={() => p.setSource('file')}
                label="A file on this computer" description="An image or bootloader file (.img, .bin, or compressed with xz, gzip or bzip2). It is written from the first sector."
                body={p.source === 'file' ? fileRow(
                  <Button variant="secondary" onClick={p.pickFile} isLoading={p.picking} isDisabled={p.picking}>Choose file</Button>,
                  p.file ? `${p.file.name}, ${formatBytes(p.file.size)}` : 'No file chosen',
                ) : undefined} />
              {p.fileError && <Alert variant="danger" isInline isPlain title={p.fileError} />}
            </FormGroup>
            <FormGroup fieldId="connect" label="Connect the board in Maskrom mode">
              <Content id="connect">
                <ol>
                  <li>Disconnect power from the board.</li>
                  <li>Hold the Maskrom button and connect the board's USB-C port to this computer.</li>
                  <li>Release the button after two seconds.</li>
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

function ReviewFooter({ canWrite, why, onWrite }: { canWrite: boolean; why: string | null; onWrite: () => void }) {
  const { goToPrevStep } = useWizardContext();
  return (
    <WizardFooterWrapper>
      {/* As anaconda's footer: helper text above the buttons. */}
      <Stack hasGutter>
        {why && <Content component="p" className="footer-note">{why}</Content>}
        <ActionList>
          <ActionListGroup>
            <ActionListItem><Button variant="secondary" onClick={goToPrevStep}>Back</Button></ActionListItem>
            <ActionListItem><Button variant="danger" onClick={onWrite} isDisabled={!canWrite}>Erase and write</Button></ActionListItem>
          </ActionListGroup>
        </ActionList>
      </Stack>
    </WizardFooterWrapper>
  );
}

/* The write itself replaces the wizard, as the installer's progress page does. */
function RunView({ run, onCancel, onDone, reconnect }: { run: Run; onCancel: () => void; onDone: () => void; reconnect: boolean }) {
  return (
    <PageSection isFilled aria-label="Writing">
      <Stack hasGutter className="step">
        <Title headingLevel="h2">{run.result ? (run.result.ok ? 'Done' : 'Stopped') : 'Writing'}</Title>
        {/* Twice the space between stages as between a stage's title and its bar. */}
        <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsXl' }}>
          {run.stages.map((s) => (
            <FlexItem key={s.id}>
              <Progress
                title={s.label + (s.detail ? `: ${s.detail}` : '')}
                value={s.percent ?? 0}
                // A stage with no percentage (the loader) says so in words.
                {...(s.percent === null ? { label: 'Waiting', valueText: 'Waiting' } : {})}
                measureLocation={ProgressMeasureLocation.top}
                aria-label={s.label}
              />
            </FlexItem>
          ))}
        </Flex>
        {reconnect && !run.result && (
          <Alert isInline variant="info" title="Choose the board again"
            actionLinks={<Button variant="secondary" onClick={() => { navigator.usb.requestDevice({ filters: [{ vendorId: 0x2207 }] }).catch(() => {}); }}>Choose the board</Button>}>
            The board restarted with the loader. The browser needs you to pick it once more.
          </Alert>
        )}
        {run.result && (
          <Alert isInline variant={run.result.ok ? 'success' : 'danger'} title={run.result.title}>
            <p>{run.result.text}</p>
            {run.result.detail && <p className="detail">{run.result.detail}</p>}
          </Alert>
        )}
        <StackItem>
          {run.result
            ? <Button variant="primary" onClick={onDone}>Write another</Button>
            : <Button variant="secondary" onClick={onCancel}>Cancel</Button>}
        </StackItem>
        {run.log.length > 0 && (
          <ExpandableSection toggleText="rkdeveloptool output" className="log">
            <CodeBlock><CodeBlockCode>{run.log.slice(-400).join('\n')}</CodeBlockCode></CodeBlock>
          </ExpandableSection>
        )}
      </Stack>
    </PageSection>
  );
}

function SettingsModal({ open, onClose, theme, setTheme }: { open: boolean; onClose: () => void; theme: Theme; setTheme: (t: Theme) => void }) {
  const [s, setS] = useState<{ updateCheck: boolean; resetAfterMaskrom: boolean } | null>(null);
  useEffect(() => { if (open) api.getSettings().then(setS); }, [open]);
  const set = (patch: Partial<{ updateCheck: boolean; resetAfterMaskrom: boolean }>) => {
    setS((cur) => (cur ? { ...cur, ...patch } : cur));
    api.setSettings(patch);
  };
  return (
    <Modal isOpen={open} onClose={onClose} variant="small" aria-labelledby="settings-title">
      <ModalHeader title="Settings" labelId="settings-title" />
      <ModalBody>
        {s && (
          <Form onSubmit={(e) => e.preventDefault()}>
            {!WEB && (
              <Switch id="set-update" label="Check for a new version once a day" isChecked={s.updateCheck}
                onChange={(_e, v) => set({ updateCheck: v })} />
            )}
            <Switch id="set-reset" label="Restart the board after a Maskrom write" isChecked={s.resetAfterMaskrom}
              onChange={(_e, v) => set({ resetAfterMaskrom: v })} />
            <FormGroup label="Appearance" fieldId="appearance" role="group">
              <ToggleGroup aria-label="Appearance" id="appearance">
                {(['system', 'light', 'dark'] as Theme[]).map((t) => (
                  <ToggleGroupItem key={t} text={t[0].toUpperCase() + t.slice(1)} isSelected={theme === t} onChange={() => setTheme(t)} />
                ))}
              </ToggleGroup>
            </FormGroup>
            <DescriptionList isCompact isHorizontal>
              <DescriptionListGroup><DescriptionListTerm>Version</DescriptionListTerm><DescriptionListDescription>{api.version}</DescriptionListDescription></DescriptionListGroup>
              <DescriptionListGroup><DescriptionListTerm>License</DescriptionListTerm><DescriptionListDescription>GPL-2.0</DescriptionListDescription></DescriptionListGroup>
              <DescriptionListGroup><DescriptionListTerm>Source</DescriptionListTerm><DescriptionListDescription>
                <Button variant="link" isInline component="a" href="https://github.com/roxora-os/imager" target="_blank">github.com/roxora-os/imager</Button>
              </DescriptionListDescription></DescriptionListGroup>
            </DescriptionList>
          </Form>
        )}
      </ModalBody>
      <ModalFooter><Button variant="primary" onClick={onClose}>Close</Button></ModalFooter>
    </Modal>
  );
}

export function App() {
  const [theme, setThemeState] = useState<Theme>(readTheme());
  const setTheme = (t: Theme) => { setThemeState(t); applyTheme(t); };
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
  const [confirm, setConfirm] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [settings, setSettings] = useState(false);
  const [update, setUpdate] = useState<{ version: string; url: string } | null>(null);
  const [usbChoices, setUsbChoices] = useState<{ deviceId: string; productName?: string; productId: number }[] | null>(null);
  const maskromJob = useRef<MaskromJob | null>(null);

  const load = useCallback(() => {
    setCatalog(null);
    api.loadCatalog({ sample: useSample }).then(setCatalog);
  }, [useSample]);
  useEffect(load, [load]);
  useEffect(() => { api.checkUpdate(false).then(setUpdate); }, []);
  useEffect(() => api.onUsbChoice(setUsbChoices), []);

  const boards = useMemo(() => (catalog?.state === 'ok' ? groupByBoard(catalog.images) : []), [catalog]);
  const cur = boards.find((b) => b.board === board);
  const image = cur?.images.find((i) => i.id === imageId);
  const mb = board ? maskromBoard(board) : undefined;
  const sample = catalog?.state === 'ok' && catalog.sample;

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

  const refreshDrives = useCallback(() => {
    setDrives(null);
    api.listDrives(image?.extractSize ?? 0).then((d) => {
      setDrives(d);
      setDevice((cur) => (d.targets.some((t) => t.device === cur && !t.disabled) ? cur : null));
    });
  }, [image?.extractSize]);

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
    setChecking({ label: 'Checking the file against the release', done: 0, total: 0 });
    const r = await api.pickReleaseFile(image.id, source === 'spi' ? 'spi' : 'image',
      (d, t) => setChecking({ label: 'Checking the file against the release', done: d, total: t }));
    setChecking(null);
    if (!r) return;
    if ('error' in r) { setReleaseFile(null); setFileError(r.error); return; }
    setReleaseFile(r);
  };
  const downloadRelease = async () => {
    if (!image || !api.downloadReleaseFile) return;
    setFileError(null);
    setChecking({ label: 'Downloading and checking', done: 0, total: 0 });
    const r = await api.downloadReleaseFile(image.id, source === 'spi' ? 'spi' : 'image',
      (d, t) => setChecking({ label: 'Downloading and checking', done: d, total: t }));
    setChecking(null);
    if ('error' in r) { setReleaseFile(null); setProxyError(r.error); return; }
    setReleaseFile(r);
  };
  // A picked release file belongs to one image and one kind.
  useEffect(() => { setReleaseFile(null); setProxyError(null); }, [imageId, source]);

  const target = drives?.targets.find((t) => t.device === device);
  const destReady = method === 'sd' ? !!target
    : !!storage && (source === 'file' ? !!file
      : source === 'spi' ? !!image?.spi && storage === 'spinor' && (!WEB || !!releaseFile)
        : !!image && !!mb?.wholeImage.includes(storage) && (!WEB || !!releaseFile));

  let why: string | null = null;
  if (sample) why = 'Sample data cannot be written.';
  else if (!destReady) why = 'Choose a destination first.';

  const erasedWhat = method === 'sd'
    ? (target ? `${target.description} (${target.device}, ${formatBytes(target.size)})` : '')
    : (storage && mb ? `the ${storage === 'sd' ? 'SD card in the board' : STORAGES[storage].label} (${mb.boardName}, connected over USB)` : '');
  const erased = erasedWhat ? `Everything on ${erasedWhat}.` : '';

  const startSd = async () => {
    if (!image || !target) return;
    const r: Run = {
      kind: 'sd', log: [], result: null,
      stages: [
        { id: 'download', label: 'Download and check', percent: 0 },
        { id: 'write', label: `Write ${target.device}`, percent: 0 },
        { id: 'verify', label: 'Read back and compare with the release', percent: 0 },
      ],
    };
    setRun(r);
    const off = api.onProgress((p: JobProgress) => {
      const id = p.stage === 'check' || p.stage === 'download' ? 'download' : p.stage;
      const pct = p.total ? Math.min(100, Math.floor(p.bytes * 100 / p.total)) : null;
      setRun((cur) => cur && { ...cur, stages: cur.stages.map((s) => (s.id === id ? { ...s, percent: pct } : s)) });
    });
    const res = await api.writeSd(image.id, target.device);
    off();
    setRun((cur) => cur && {
      ...cur,
      result: res.ok
        ? { ok: true, title: 'Written and verified', text: `${target.description} holds ${image.file}. The read-back matches the release (SHA-256 ${res.sha256}). You can remove the drive.` }
        : { ok: false, title: res.reason, text: 'The drive may be partly written.', ...(res.detail ? { detail: res.detail } : {}) },
    });
  };

  const startMaskromWrite = async () => {
    if (!storage || !mb) return;
    const st = STORAGES[storage];
    const r: Run = {
      kind: 'maskrom', log: [], result: null,
      stages: [
        { id: 'prepare', label: source === 'release' ? 'Download, check and decompress' : source === 'spi' ? 'Download and check' : 'Prepare the file', percent: 0 },
        { id: 'loader', label: 'Send the loader and wait for the board', percent: null },
        { id: 'write', label: `Write ${st.label}`, percent: 0 },
        { id: 'verify', label: 'Read back and compare', percent: 0 },
      ],
    };
    setRun(r);
    const setStage = (id: string, patch: Partial<Run['stages'][number]>) =>
      setRun((cur) => cur && { ...cur, stages: cur.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
    const finish = (result: Run['result']) => setRun((cur) => cur && { ...cur, result });

    let prepared = source === 'file' ? file : WEB ? releaseFile : null;
    if (!WEB && (source === 'release' || source === 'spi') && image) {
      const off = api.onProgress((p) => setStage('prepare', { percent: p.total ? Math.min(100, Math.floor(p.bytes * 100 / p.total)) : null, detail: p.stage }));
      const res = await api.prepareMaskrom(image.id, source === 'spi' ? 'spi' : 'image');
      off();
      if ('error' in res) { finish({ ok: false, title: res.error, text: 'Nothing was written.' }); return; }
      prepared = res;
    }
    if (!prepared) return;
    setStage('prepare', { percent: 100, detail: undefined });
    // Rockchip's loader is not shipped: built from rkbin on first use.
    setStage('loader', { percent: null, detail: "getting Rockchip's loader" });
    const loader = await api.getLoader(mb.loader);
    if ('error' in loader) {
      if (source !== 'file') api.releaseMaskrom(prepared.token);
      finish({ ok: false, title: loader.error, text: 'Nothing was written.' });
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
        if (s === 'loader' || s === 'reconnect') setStage('loader', { percent: null, detail: s === 'reconnect' ? 'waiting for the board' : undefined });
        // A browser forgets the board when it restarts in Loader mode; it has
        // to be chosen again (the desktop app finds it by itself).
        if (s === 'reconnect' && WEB) setReconnect(true);
        if (s === 'storage') { setReconnect(false); setStage('loader', { percent: 100, detail: undefined }); }
      },
      progress: (s, pct) => { if (s === 'write' || s === 'verify') setStage(s, { percent: pct }); },
    });
    maskromJob.current = job;
    const res = await job.done;
    maskromJob.current = null;
    setReconnect(false);
    if (source !== 'file') api.releaseMaskrom(prepared.token);
    finish(res.ok
      ? { ok: true, title: 'Written and verified', text: `${prepared.name} is on the ${st.label}. The read-back matches (SHA-256 ${res.sha256}).${settingsNow.resetAfterMaskrom ? ' The board is restarting.' : ''}` }
      : { ok: false, title: res.reason, text: 'Check the connection and the output below.', ...(res.detail ? { detail: res.detail } : {}) });
  };

  const onWrite = () => setConfirm(true);
  const doWrite = () => {
    setConfirm(false);
    if (method === 'sd') { startSd(); return; }
    if (WEB) {
      // WebUSB only shows devices the user picked; this click is the gesture.
      navigator.usb.requestDevice({ filters: [{ vendorId: 0x2207 }] })
        .then(() => startMaskromWrite(), () => setFileError('No board was chosen. Connect it in Maskrom mode and try again.'));
      return;
    }
    startMaskromWrite();
  };
  const cancel = () => {
    if (maskromJob.current) maskromJob.current.cancel();
    else api.cancel();
  };

  const finishRun = () => { setRun(null); setDevice(null); };

  // Notices about the whole app sit under the first step's title. The ones
  // that stop a write (sample data, no WebUSB) show again on the review.
  const noUsb = WEB && !('usb' in navigator) && (
    <Alert isInline variant="warning" title="This browser cannot reach USB devices">
      Writing over USB needs WebUSB, which Chrome, Edge and other Chromium browsers have. Or use
      the <Button variant="link" isInline component="a" href={DESKTOP_URL} target="_blank">desktop app</Button>.
    </Alert>
  );
  const sampleNote = sample && (
    <Alert isInline variant="warning" title="Sample data"
      actionLinks={<Button variant="link" isInline onClick={() => setUseSample(false)}>Load the real releases</Button>}>
      These entries come from the sample catalog in the release contract. The releases do not exist and nothing
      can be written.
    </Alert>
  );
  const notices = (
    <>
      {update && (
        <Alert isInline variant="info" title={`Roxora Imager ${update.version} is available`}
          actionLinks={<Button variant="link" isInline component="a" href={update.url} target="_blank">Release page</Button>} />
      )}
      {noUsb}
      {sampleNote}
    </>
  );
  const writeNotices = <>{noUsb}{sampleNote}</>;

  return (
    <Shell onSettings={() => setSettings(true)}>
      {run ? <RunView run={run} onCancel={cancel} onDone={finishRun} reconnect={reconnect} /> : (
        <PageSection type="wizard" isFilled hasBodyWrapper={false} aria-label="Write an image">
          <Wizard navAriaLabel="Steps" isVisitRequired onStepChange={(_e, step) => { if (step.id === 'dest' && method === 'sd') refreshDrives(); }}>
            <WizardStep name="Board" id="board" footer={{ isNextDisabled: !board, isCancelHidden: true }}>
              <BoardStep catalog={catalog} boards={boards} board={board} setBoard={chooseBoard} reload={load}
                find={{ query, setQuery, vendor, setVendor }} notices={notices} />
            </WizardStep>
            <WizardStep name="Image" id="image" isDisabled={!board} footer={{ isNextDisabled: !imageId, isCancelHidden: true }}>
              <ImageStep board={cur} imageId={imageId} setImage={setImageId} />
            </WizardStep>
            <WizardStep name="Destination" id="dest" isDisabled={!imageId} footer={{ isNextDisabled: !destReady, isCancelHidden: true, nextButtonText: 'Review' }}>
              <DestinationStep boardName={cur?.boardName ?? ''} boardId={board ?? ''} image={image}
                method={method} setMethod={(m) => { setMethod(m); if (m === 'sd') refreshDrives(); }}
                drives={drives} refreshDrives={refreshDrives} device={device} setDevice={setDevice}
                storage={storage} setStorage={(s) => { setStorage(s); setSource(mb?.wholeImage.includes(s) ? 'release' : s === 'spinor' && image?.spi ? 'spi' : 'file'); }}
                source={source} setSource={setSource} file={file} pickFile={pickFile} picking={picking} fileError={fileError}
                releaseFile={releaseFile} pickRelease={pickRelease} checking={checking}
                downloadRelease={downloadRelease} proxyError={proxyError} />
            </WizardStep>
            <WizardStep name="Review" id="review" isDisabled={!destReady}
              footer={<ReviewFooter canWrite={!why} why={why} onWrite={onWrite} />}>
              <StepPage title="Review" lead="Nothing has been written yet. Check this before you go on." notices={writeNotices}>
                {erasedWhat && <Alert isInline variant="danger" title={`Everything on ${erasedWhat} will be erased.`} />}
              <DescriptionList isHorizontal>
                <DescriptionListGroup><DescriptionListTerm>Board</DescriptionListTerm><DescriptionListDescription>{cur?.boardName}</DescriptionListDescription></DescriptionListGroup>
                {(method === 'sd' || source === 'release') && image && (
                  <>
                    <DescriptionListGroup><DescriptionListTerm>Image</DescriptionListTerm><DescriptionListDescription>{image.file}</DescriptionListDescription></DescriptionListGroup>
                    <DescriptionListGroup><DescriptionListTerm>Release</DescriptionListTerm><DescriptionListDescription>{releaseWords(image)}, {image.releaseInfo.date}. {statusWords(image.status)}.</DescriptionListDescription></DescriptionListGroup>
                  </>
                )}
                {method === 'maskrom' && source === 'spi' && image?.spi && (
                  <DescriptionListGroup><DescriptionListTerm>SPI bootloader</DescriptionListTerm><DescriptionListDescription>{image.spi.file}, {formatBytes(image.spi.size)}, from {releaseWords(image).toLowerCase()}</DescriptionListDescription></DescriptionListGroup>
                )}
                {WEB && source !== 'file' && releaseFile && (
                  <DescriptionListGroup><DescriptionListTerm>Release file</DescriptionListTerm><DescriptionListDescription>{releaseFile.name}, matches the release SHA-256</DescriptionListDescription></DescriptionListGroup>
                )}
                {method === 'maskrom' && source === 'file' && file && (
                  <DescriptionListGroup><DescriptionListTerm>File</DescriptionListTerm><DescriptionListDescription>{file.name}, {formatBytes(file.size)}</DescriptionListDescription></DescriptionListGroup>
                )}
                <DescriptionListGroup><DescriptionListTerm>Destination</DescriptionListTerm><DescriptionListDescription>
                  {method === 'sd' ? (target ? `${target.description}, ${target.device}, ${formatBytes(target.size)}` : '')
                    : (storage ? `${STORAGES[storage].label} of the board, over USB in Maskrom mode` : '')}
                </DescriptionListDescription></DescriptionListGroup>
                <DescriptionListGroup><DescriptionListTerm>Checks</DescriptionListTerm><DescriptionListDescription>
                  {method === 'sd' || source === 'release' || source === 'spi'
                    ? 'The download is checked against the release SHA-256. After writing, the destination is read back and compared with the release SHA-256.'
                    : 'After writing, the storage is read back and compared with the file.'}
                </DescriptionListDescription></DescriptionListGroup>
              </DescriptionList>
              </StepPage>
            </WizardStep>
          </Wizard>
        </PageSection>
      )}

      <Modal isOpen={confirm} onClose={() => setConfirm(false)} variant="small" aria-labelledby="confirm-title">
        <ModalHeader title="Erase and write?" labelId="confirm-title" titleIconVariant="warning" />
        <ModalBody>{erased} This cannot be undone.</ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={doWrite}>Erase and write</Button>
          <Button variant="link" onClick={() => setConfirm(false)}>Cancel</Button>
        </ModalFooter>
      </Modal>

      <Modal isOpen={!!usbChoices} onClose={() => { api.answerUsbChoice(''); setUsbChoices(null); }} variant="small" aria-labelledby="usb-title">
        <ModalHeader title="Several Rockchip devices are connected" labelId="usb-title" />
        <ModalBody>
          <Stack hasGutter>
            <Content component="p">Choose the board to write, or disconnect the others.</Content>
            {usbChoices?.map((c) => (
              <StackItem key={c.deviceId}>
                <Button variant="secondary" onClick={() => { api.answerUsbChoice(c.deviceId); setUsbChoices(null); }}>
                  {c.productName || 'Rockchip device'} (product 0x{c.productId.toString(16)})
                </Button>
              </StackItem>
            ))}
          </Stack>
        </ModalBody>
      </Modal>

      <SettingsModal open={settings} onClose={() => setSettings(false)} theme={theme} setTheme={setTheme} />
    </Shell>
  );
}
