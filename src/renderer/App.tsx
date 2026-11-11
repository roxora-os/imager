import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Card, CardBody, CardHeader, CardTitle, CodeBlock, CodeBlockCode, Content, DescriptionList,
  DescriptionListDescription, DescriptionListGroup, DescriptionListTerm, EmptyState, EmptyStateBody,
  EmptyStateFooter, ExpandableSection, Masthead, MastheadBrand, MastheadContent, MastheadLogo, MastheadMain,
  Modal, ModalBody, ModalFooter, ModalHeader, Page, PageSection, Progress, ProgressMeasureLocation, Radio,
  SearchInput, Menu, MenuContent, MenuItem, MenuList, FormSelect, FormSelectOption,
  Spinner, Switch, Title, ToggleGroup, ToggleGroupItem, Wizard, WizardFooterWrapper, WizardStep, useWizardContext,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { groupByBoard, type Board, type CatalogImage } from '../shared/catalog';
import { BOARD_REQUEST_URL, queryWords, vendorCounts, visibleBoards } from '../shared/boardsearch';
import { formatBytes, statusWords } from '../shared/format';
import type { CatalogResult, ImagerApi, JobProgress, PreparedFile } from '../shared/ipc';
import type { HiddenDrive, Target } from '../shared/targets';
import { maskromBoard, STORAGES, type StorageId } from '../maskrom/boards';
import type { Stage } from '../maskrom/sequence';
import { startMaskrom, type MaskromJob } from './maskrom-client';
import { readTheme, applyTheme, type Theme } from './theme';

declare global {
  interface Window { imager: ImagerApi }
}
const api = window.imager;

type Method = 'sd' | 'maskrom';
type MaskromSource = 'release' | 'spi' | 'file';

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

/* The page shell: masthead with the mark, a settings button. */
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
      <MastheadContent className="masthead-actions">
        <Button variant="secondary" onClick={onSettings}>Settings</Button>
      </MastheadContent>
    </Masthead>
  );
  return <Page masthead={masthead}>{children}</Page>;
}

interface FindState { query: string; setQuery: (q: string) => void; vendor: string; setVendor: (v: string) => void }

function BoardStep({ catalog, boards, board, setBoard, reload, find }: {
  catalog: CatalogResult | null; boards: Board[]; board: string | null;
  setBoard: (b: string) => void; reload: () => void; find: FindState;
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
          <Button variant="link" isInline component="a" href={RELEASES_URL} target="_blank">Releases on GitHub</Button>
          <Button variant="secondary" onClick={reload}>Check again</Button>
        </EmptyStateFooter>
      </EmptyState>
    );
  }
  return <BoardPicker boards={boards} board={board} setBoard={setBoard} find={find} />;
}

const ALL = '__all';

function BoardPicker({ boards, board, setBoard, find }: {
  boards: Board[]; board: string | null; setBoard: (b: string) => void; find: FindState;
}) {
  const { query, setQuery, vendor, setVendor } = find;
  const searching = queryWords(query).length > 0;
  const counts = useMemo(() => vendorCounts(boards, query), [boards, query]);
  const shown = useMemo(() => visibleBoards(boards, vendor === ALL ? null : vendor, query), [boards, vendor, query]);
  const total = searching ? shown.length : boards.length;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLInputElement>('input')?.focus(); }, []);

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

  return (
    <>
      <Title headingLevel="h2" className="step-title">Board</Title>
      <Content component="p" className="step-lead">Choose the board you want to install Roxora on.</Content>
      <div ref={box} onKeyDown={onKeyDown} className="board-search">
        <SearchInput placeholder="Search boards, vendors or SoCs" value={query} aria-label="Search boards, vendors or SoCs"
          onChange={(_e, v) => setQuery(v)} onClear={() => setQuery('')} />
      </div>
      <div className="board-panes">
        <div className="vendor-pane">
          <Menu isPlain activeItemId={active} onSelect={(_e, id) => pick(String(id ?? ALL))} aria-label="Vendors">
            <MenuContent>
              <MenuList>
                <MenuItem itemId={ALL} isActive={active === ALL}>
                  <span className="vendor-row"><span>All vendors</span><span className="vendor-count">{total}</span></span>
                </MenuItem>
                {counts.map((c) => (
                  <MenuItem key={c.vendor} itemId={c.vendor} isActive={active === c.vendor} isDisabled={searching && c.count === 0}>
                    <span className="vendor-row"><span>{c.vendor}</span><span className="vendor-count">{c.count}</span></span>
                  </MenuItem>
                ))}
              </MenuList>
            </MenuContent>
          </Menu>
        </div>
        <div className="vendor-select">
          <FormSelect value={active} onChange={(_e, v) => pick(v)} aria-label="Vendor">
            <FormSelectOption value={ALL} label={vendorLabel('All vendors', total)} />
            {counts.map((c) => (
              <FormSelectOption key={c.vendor} value={c.vendor} label={vendorLabel(c.vendor, c.count)} isDisabled={searching && c.count === 0} />
            ))}
          </FormSelect>
        </div>
        <div className="board-pane">
          {shown.length === 0 ? (
            <Content component="p" className="no-match">
              No board matches &ldquo;{query.trim()}&rdquo;.{' '}
              <Button variant="link" isInline component="a" href={BOARD_REQUEST_URL} target="_blank">Ask for a board to be supported</Button>
            </Content>
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
        </div>
      </div>
    </>
  );
}

function ImageStep({ board, imageId, setImage }: { board: Board | undefined; imageId: string | null; setImage: (id: string) => void }) {
  if (!board) return null;
  const sel = board.images.find((i) => i.id === imageId);
  return (
    <>
      <Title headingLevel="h2" className="step-title">Image</Title>
      <Content component="p" className="step-lead">Images for {board.boardName}, newest first.</Content>
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
        <Content component="p" className="step-note">
          {statusWords(sel.status)}. {sel.releaseInfo.prerelease
            ? 'Pre-releases have not been through the full hardware test.' : ''}{' '}
          <Button variant="link" isInline component="a" href={sel.releaseInfo.url} target="_blank">Release notes</Button>
        </Content>
      )}
    </>
  );
}

function DriversNote() {
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
}) {
  const mb = maskromBoard(p.boardId);
  return (
    <>
      <Title headingLevel="h2" className="step-title">Destination</Title>
      <div className="method">
        <Radio id="method-sd" name="method" isChecked={p.method === 'sd'} onChange={() => p.setMethod('sd')}
          label="SD card or USB drive" description="Write the image to a card or stick in this computer, then boot the board from it." />
        <Radio id="method-maskrom" name="method" isChecked={p.method === 'maskrom'} onChange={() => p.setMethod('maskrom')}
          isDisabled={!mb}
          label="Board storage over USB (Maskrom)"
          description={mb ? `Write ${mb.storages.map((s) => STORAGES[s].label).join(' or ')} on the ${p.boardName} through its USB-C port.`
            : `Maskrom writing is not set up for ${p.boardName}.`} />
      </div>

      {p.method === 'sd' && (
        <Card className="dest-card">
          <CardHeader actions={{ actions: <Button variant="secondary" onClick={p.refreshDrives}>Refresh</Button>, hasNoOffset: true }}>
            <CardTitle>Drives</CardTitle>
          </CardHeader>
          <CardBody>
            {!p.drives ? <Spinner size="md" aria-label="Looking for drives" /> : p.drives.targets.length === 0 ? (
              <Content component="p">No SD card or USB drive found. Insert one and click Refresh.</Content>
            ) : (
              <Table aria-label="Drives" variant="compact">
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
              <ExpandableSection toggleText={`${p.drives.hidden.length} ${p.drives.hidden.length === 1 ? 'drive is' : 'drives are'} not offered`} className="hidden-drives">
                <ul>{p.drives.hidden.map((h) => <li key={h.device}>{h.device} {h.description}: {h.reason}</li>)}</ul>
              </ExpandableSection>
            )}
          </CardBody>
        </Card>
      )}

      {p.method === 'maskrom' && mb && (
        <>
          <Card className="dest-card">
            <CardTitle>Storage</CardTitle>
            <CardBody>
              {mb.storages.map((s) => (
                <Radio key={s} id={`storage-${s}`} name="storage" isChecked={p.storage === s} onChange={() => p.setStorage(s)}
                  label={STORAGES[s].label} description={STORAGES[s].note} />
              ))}
            </CardBody>
          </Card>
          <Card className="dest-card">
            <CardTitle>What to write</CardTitle>
            <CardBody>
              <Radio id="src-release" name="source" isChecked={p.source === 'release'} onChange={() => p.setSource('release')}
                isDisabled={mb.imageStorage === null || p.storage !== mb.imageStorage}
                label={p.image ? `The image chosen in the previous step (${p.image.file})` : 'The image chosen in the previous step'}
                description={mb.imageStorage === null ? mb.imageNote : p.storage !== mb.imageStorage ? `A whole image goes to ${STORAGES[mb.imageStorage].label}.` : undefined} />
              {mb.storages.includes('spinor') && (
                <Radio id="src-spi" name="source" isChecked={p.source === 'spi'} onChange={() => p.setSource('spi')}
                  isDisabled={!p.image?.spi || p.storage !== 'spinor'}
                  label={p.image?.spi ? `This release's SPI bootloader (${p.image.spi.file}, ${formatBytes(p.image.spi.size)})` : "This release's SPI bootloader"}
                  description={!p.image?.spi ? 'This release has no SPI bootloader for the board.'
                    : 'Downloaded from the release and checked against its SHA-256, then read back after writing.'} />
              )}
              <Radio id="src-file" name="source" isChecked={p.source === 'file'} onChange={() => p.setSource('file')}
                label="A file on this computer" description="An image or bootloader file (.img, .bin, or compressed with xz, gzip or bzip2). It is written from the first sector." />
              {p.source === 'file' && (
                <div className="file-row">
                  <Button variant="secondary" onClick={p.pickFile} isLoading={p.picking} isDisabled={p.picking}>Choose file</Button>
                  <span>{p.file ? `${p.file.name}, ${formatBytes(p.file.size)}` : 'No file chosen'}</span>
                </div>
              )}
              {p.fileError && <Alert variant="danger" isInline isPlain title={p.fileError} />}
            </CardBody>
          </Card>
          <Card className="dest-card">
            <CardTitle>Connect the board in Maskrom mode</CardTitle>
            <CardBody>
              <Content component="ol">
                <li>Disconnect power from the board.</li>
                <li>Hold the Maskrom button and connect the board's USB-C port to this computer.</li>
                <li>Release the button after two seconds.</li>
              </Content>
              <DriversNote />
            </CardBody>
          </Card>
        </>
      )}
    </>
  );
}

function ReviewFooter({ canWrite, why, onWrite }: { canWrite: boolean; why: string | null; onWrite: () => void }) {
  const { goToPrevStep } = useWizardContext();
  return (
    <WizardFooterWrapper>
      <Button variant="danger" onClick={onWrite} isDisabled={!canWrite}>Erase and write</Button>
      <Button variant="secondary" onClick={goToPrevStep}>Back</Button>
      {why && <span className="footer-note">{why}</span>}
    </WizardFooterWrapper>
  );
}

function RunView({ run, onCancel, onDone }: { run: Run; onCancel: () => void; onDone: () => void }) {
  return (
    <PageSection className="run">
      <Card>
        <CardTitle><Title headingLevel="h2">{run.result ? (run.result.ok ? 'Done' : 'Stopped') : 'Writing'}</Title></CardTitle>
        <CardBody>
          {run.stages.map((s) => (
            <div key={s.id} className="stage">
              <Progress
                title={s.label + (s.detail ? `: ${s.detail}` : '')}
                value={s.percent ?? 0}
                measureLocation={s.percent === null ? ProgressMeasureLocation.none : ProgressMeasureLocation.outside}
                aria-label={s.label}
              />
            </div>
          ))}
          {run.result && (
            <Alert isInline variant={run.result.ok ? 'success' : 'danger'} title={run.result.title} className="result">
              <p>{run.result.text}</p>
              {run.result.detail && <p className="detail">{run.result.detail}</p>}
            </Alert>
          )}
          {run.log.length > 0 && (
            <ExpandableSection toggleText="rkdeveloptool output" className="log">
              <CodeBlock><CodeBlockCode>{run.log.slice(-400).join('\n')}</CodeBlockCode></CodeBlock>
            </ExpandableSection>
          )}
        </CardBody>
        <div className="run-actions">
          {run.result
            ? <Button variant="primary" onClick={onDone}>Write another</Button>
            : <Button variant="secondary" onClick={onCancel}>Cancel</Button>}
        </div>
      </Card>
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
          <div className="settings">
            <Switch id="set-update" label="Check for a new version once a day" isChecked={s.updateCheck}
              onChange={(_e, v) => set({ updateCheck: v })} />
            <Switch id="set-reset" label="Restart the board after a Maskrom write" isChecked={s.resetAfterMaskrom}
              onChange={(_e, v) => set({ resetAfterMaskrom: v })} />
            <div>
              <div className="settings-label">Appearance</div>
              <ToggleGroup aria-label="Appearance">
                {(['system', 'light', 'dark'] as Theme[]).map((t) => (
                  <ToggleGroupItem key={t} text={t[0].toUpperCase() + t.slice(1)} isSelected={theme === t} onChange={() => setTheme(t)} />
                ))}
              </ToggleGroup>
            </div>
            <DescriptionList isCompact isHorizontal>
              <DescriptionListGroup><DescriptionListTerm>Version</DescriptionListTerm><DescriptionListDescription>{api.version}</DescriptionListDescription></DescriptionListGroup>
              <DescriptionListGroup><DescriptionListTerm>License</DescriptionListTerm><DescriptionListDescription>GPL-2.0</DescriptionListDescription></DescriptionListGroup>
              <DescriptionListGroup><DescriptionListTerm>Source</DescriptionListTerm><DescriptionListDescription>
                <Button variant="link" isInline component="a" href="https://github.com/roxora-os/imager" target="_blank">github.com/roxora-os/imager</Button>
              </DescriptionListDescription></DescriptionListGroup>
            </DescriptionList>
          </div>
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
  const [method, setMethod] = useState<Method>('sd');
  const [drives, setDrives] = useState<{ targets: Target[]; hidden: HiddenDrive[] } | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageId | null>(null);
  const [source, setSource] = useState<MaskromSource>('release');
  const [file, setFile] = useState<PreparedFile | null>(null);
  const [picking, setPicking] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
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

  const target = drives?.targets.find((t) => t.device === device);
  const destReady = method === 'sd' ? !!target
    : !!storage && (source === 'file' ? !!file
      : source === 'spi' ? !!image?.spi && storage === 'spinor'
        : !!image && mb?.imageStorage === storage);

  let why: string | null = null;
  if (sample) why = 'Sample data cannot be written.';
  else if (!destReady) why = 'Choose a destination first.';

  const erased = method === 'sd'
    ? (target ? `Everything on ${target.description} (${target.device}, ${formatBytes(target.size)}).` : '')
    : (storage && mb ? `Everything on the ${STORAGES[storage].label} of the ${mb.boardName} connected over USB.` : '');

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

    let prepared = file;
    if ((source === 'release' || source === 'spi') && image) {
      const off = api.onProgress((p) => setStage('prepare', { percent: p.total ? Math.min(100, Math.floor(p.bytes * 100 / p.total)) : null, detail: p.stage }));
      const res = await api.prepareMaskrom(image.id, source === 'spi' ? 'spi' : 'image');
      off();
      if ('error' in res) { finish({ ok: false, title: res.error, text: 'Nothing was written.' }); return; }
      prepared = res;
    }
    if (!prepared) return;
    setStage('prepare', { percent: 100, detail: undefined });
    const settingsNow = await api.getSettings();
    const job = startMaskrom({
      loader: mb.loader, fileUrl: prepared.url, size: prepared.size, sha256: prepared.sha256,
      storageCode: st.code, storageLabel: st.label, verify: true, resetAfter: settingsNow.resetAfterMaskrom,
    }, {
      log: (line) => setRun((cur) => cur && { ...cur, log: [...cur.log, line] }),
      stage: (s: Stage) => {
        if (s === 'loader' || s === 'reconnect') setStage('loader', { percent: null, detail: s === 'reconnect' ? 'waiting for the board' : undefined });
        if (s === 'storage') setStage('loader', { percent: 100, detail: undefined });
      },
      progress: (s, pct) => { if (s === 'write' || s === 'verify') setStage(s, { percent: pct }); },
    });
    maskromJob.current = job;
    const res = await job.done;
    maskromJob.current = null;
    if (source !== 'file') api.releaseMaskrom(prepared.token);
    finish(res.ok
      ? { ok: true, title: 'Written and verified', text: `${prepared.name} is on the ${st.label}. The read-back matches (SHA-256 ${res.sha256}).${settingsNow.resetAfterMaskrom ? ' The board is restarting.' : ''}` }
      : { ok: false, title: res.reason, text: 'Check the connection and the output below.', ...(res.detail ? { detail: res.detail } : {}) });
  };

  const onWrite = () => setConfirm(true);
  const doWrite = () => {
    setConfirm(false);
    if (method === 'sd') startSd(); else startMaskromWrite();
  };
  const cancel = () => {
    if (maskromJob.current) maskromJob.current.cancel();
    else api.cancel();
  };

  const finishRun = () => { setRun(null); setDevice(null); };

  return (
    <Shell onSettings={() => setSettings(true)}>
      {update && (
        <PageSection className="notice">
          <Alert isInline variant="info" title={`Roxora Imager ${update.version} is available`}
            actionLinks={<Button variant="link" isInline component="a" href={update.url} target="_blank">Release page</Button>} />
        </PageSection>
      )}
      {sample && (
        <PageSection className="notice">
          <Alert isInline variant="warning" title="Sample data">
            These entries come from the sample catalog in the release contract. The releases do not exist and nothing
            can be written.{' '}
            <Button variant="link" isInline onClick={() => setUseSample(false)}>Load the real releases</Button>
          </Alert>
        </PageSection>
      )}
      {run ? <RunView run={run} onCancel={cancel} onDone={finishRun} /> : (
        <PageSection isFilled type="wizard" aria-label="Write an image">
          <Wizard navAriaLabel="Steps" isVisitRequired onStepChange={(_e, step) => { if (step.id === 'dest' && method === 'sd') refreshDrives(); }}>
            <WizardStep name="Board" id="board" footer={{ isNextDisabled: !board, isCancelHidden: true }}>
              <BoardStep catalog={catalog} boards={boards} board={board} setBoard={chooseBoard} reload={load}
                find={{ query, setQuery, vendor, setVendor }} />
            </WizardStep>
            <WizardStep name="Image" id="image" isDisabled={!board} footer={{ isNextDisabled: !imageId, isCancelHidden: true }}>
              <ImageStep board={cur} imageId={imageId} setImage={setImageId} />
            </WizardStep>
            <WizardStep name="Destination" id="dest" isDisabled={!imageId} footer={{ isNextDisabled: !destReady, isCancelHidden: true, nextButtonText: 'Review' }}>
              <DestinationStep boardName={cur?.boardName ?? ''} boardId={board ?? ''} image={image}
                method={method} setMethod={(m) => { setMethod(m); if (m === 'sd') refreshDrives(); }}
                drives={drives} refreshDrives={refreshDrives} device={device} setDevice={setDevice}
                storage={storage} setStorage={(s) => { setStorage(s); setSource(s === mb?.imageStorage ? 'release' : s === 'spinor' && image?.spi ? 'spi' : 'file'); }}
                source={source} setSource={setSource} file={file} pickFile={pickFile} picking={picking} fileError={fileError} />
            </WizardStep>
            <WizardStep name="Review" id="review" isDisabled={!destReady}
              footer={<ReviewFooter canWrite={!why} why={why} onWrite={onWrite} />}>
              <Title headingLevel="h2" className="step-title">Review</Title>
              <Content component="p" className="step-lead">Nothing has been written yet. Check this before you go on.</Content>
              <DescriptionList isHorizontal className="review">
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
                {method === 'maskrom' && source === 'file' && file && (
                  <DescriptionListGroup><DescriptionListTerm>File</DescriptionListTerm><DescriptionListDescription>{file.name}, {formatBytes(file.size)}</DescriptionListDescription></DescriptionListGroup>
                )}
                <DescriptionListGroup><DescriptionListTerm>Destination</DescriptionListTerm><DescriptionListDescription>
                  {method === 'sd' ? (target ? `${target.description}, ${target.device}, ${formatBytes(target.size)}` : '')
                    : (storage ? `${STORAGES[storage].label} of the board, over USB in Maskrom mode` : '')}
                </DescriptionListDescription></DescriptionListGroup>
                <DescriptionListGroup><DescriptionListTerm>Will be erased</DescriptionListTerm><DescriptionListDescription><strong>{erased}</strong></DescriptionListDescription></DescriptionListGroup>
                <DescriptionListGroup><DescriptionListTerm>Checks</DescriptionListTerm><DescriptionListDescription>
                  {method === 'sd' || source === 'release' || source === 'spi'
                    ? 'The download is checked against the release SHA-256. After writing, the destination is read back and compared with the release SHA-256.'
                    : 'After writing, the storage is read back and compared with the file.'}
                </DescriptionListDescription></DescriptionListGroup>
              </DescriptionList>
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
          <Content component="p">Choose the board to write, or disconnect the others.</Content>
          {usbChoices?.map((c) => (
            <Button key={c.deviceId} variant="secondary" className="usb-choice" onClick={() => { api.answerUsbChoice(c.deviceId); setUsbChoices(null); }}>
              {c.productName || 'Rockchip device'} (product 0x{c.productId.toString(16)})
            </Button>
          ))}
        </ModalBody>
      </Modal>

      <SettingsModal open={settings} onClose={() => setSettings(false)} theme={theme} setTheme={setTheme} />
    </Shell>
  );
}
