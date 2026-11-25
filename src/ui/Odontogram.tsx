import { LESION_LABEL } from '../data/cases.ts';

export type ToothMeta = {
  fdi: number;
  arch?: string;
  pos?: number;
  side?: string;
  centroid_mm?: number[];
  at?: number[];
  layer?: string;
  lesion?: string | null;
};

type Props = {
  teeth: Record<string, ToothMeta>;
  selected: number;
  hidden: number[];
  onSelect: (fdi: number) => void;
  onToggleHide: (fdi: number) => void;
};

/** Radiological convention: patient's right on the viewer's left. */
const ROWS: number[][] = [
  [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
  [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38],
];
const ALL_ORDER = [...ROWS[0], ...ROWS[1]];

/** Crown/root silhouette by tooth class, matching a clinical PACS odontogram. */
function toothPath(fdi: number, upper: boolean) {
  const pos = fdi % 10;
  if (pos >= 6) {
    return upper
      ? 'M3.2 2.2 C4.2 1.2 5.4 2.5 5.8 6.4 L8.2 6.4 C8.6 2.5 9.8 1.2 10.8 2.2 C12.0 3.8 12.2 8.2 11.8 12.4 C11.4 16.0 9.6 17.6 7.0 17.6 C4.4 17.6 2.6 16.0 2.2 12.4 C1.8 8.2 2.0 3.8 3.2 2.2 Z'
      : 'M2.2 6.4 C2.6 2.8 4.4 1.4 7.0 1.4 C9.6 1.4 11.4 2.8 11.8 6.4 C12.2 10.6 12.0 15.0 10.8 16.8 C9.8 17.8 8.6 16.5 8.2 12.6 L5.8 12.6 C5.4 16.5 4.2 17.8 3.2 16.8 C2.0 15.0 1.8 10.6 2.2 6.4 Z';
  }
  if (pos >= 4) {
    return upper
      ? 'M5.2 2.0 C6.2 1.0 7.8 1.0 8.8 2.0 C10.4 4.8 11.0 9.0 10.8 13.0 C10.5 16.2 9.0 17.5 7.0 17.5 C5.0 17.5 3.5 16.2 3.2 13.0 C3.0 9.0 3.6 4.8 5.2 2.0 Z'
      : 'M3.2 6.0 C3.5 2.8 5.0 1.5 7.0 1.5 C9.0 1.5 10.5 2.8 10.8 6.0 C11.0 10.0 10.4 14.2 8.8 17.0 C7.8 18.0 6.2 18.0 5.2 17.0 C3.6 14.2 3.0 10.0 3.2 6.0 Z';
  }
  return upper
    ? 'M6.0 1.6 C6.6 1.0 7.4 1.0 8.0 1.6 C9.4 5.2 10.3 9.8 10.0 14.2 C9.8 16.6 8.6 17.6 7.0 17.6 C5.4 17.6 4.2 16.6 4.0 14.2 C3.7 9.8 4.6 5.2 6.0 1.6 Z'
    : 'M4.0 4.8 C4.2 2.4 5.4 1.4 7.0 1.4 C8.6 1.4 9.8 2.4 10.0 4.8 C10.3 9.2 9.4 13.8 8.0 17.4 C7.4 18.0 6.6 18.0 6.0 17.4 C4.6 13.8 3.7 9.2 4.0 4.8 Z';
}

export default function Odontogram({ teeth, selected, hidden, onSelect, onToggleHide }: Props) {
  const has = (fdi: number) => !!teeth[`FDI_${fdi}`];
  const presentList = ALL_ORDER.filter(has);

  const stepTooth = (dir: -1 | 1) => {
    if (!presentList.length) return;
    const idx = presentList.indexOf(selected);
    const nextIdx = idx < 0
      ? (dir > 0 ? 0 : presentList.length - 1)
      : (idx + dir + presentList.length) % presentList.length;
    onSelect(presentList[nextIdx]);
  };

  return (
    <div className="odo">
      {ROWS.map((row, ri) => (
        <div className="odo-row" key={ri}>
          <div className="odo-cells">
            {row.map((fdi, i) => {
              const t = teeth[`FDI_${fdi}`];
              const lesion = t?.lesion ? LESION_LABEL[t.lesion] : undefined;
              const off = hidden.includes(fdi);
              const cls = [
                'odo-cell',
                selected === fdi ? 'is-sel' : '',
                off ? 'is-off' : '',
                has(fdi) ? '' : 'is-none',
                i === 8 ? 'is-mid' : '',
              ].filter(Boolean).join(' ');
              return (
                <button
                  type="button"
                  key={fdi}
                  className={cls}
                  data-fdi={fdi}
                  title={
                    t
                      ? `FDI ${fdi}${lesion ? ' · ' + lesion.cn : ''}（左键定位，右键隐藏）`
                      : `FDI ${fdi} · 当前扫描未包含`
                  }
                  onClick={() => has(fdi) && onSelect(fdi)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (has(fdi)) onToggleHide(fdi);
                  }}
                >
                  <svg viewBox="0 0 14 19" aria-hidden="true">
                    <path d={toothPath(fdi, ri === 0)} className="odo-shape" />
                  </svg>
                  <span className="odo-num">{fdi}</span>
                  {lesion && <span className="odo-dot" data-kind={t!.lesion ?? ''} />}
                  {off && <span className="odo-slash" />}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="odo-stepper">
        <button type="button" className="step-arrow" onClick={() => stepTooth(-1)} title="上一颗牙">‹</button>
        <div className="step-readout">
          <span>Tooth</span>
          <b>{selected > 0 ? selected : 'All'}</b>
          {selected > 0 && (
            <button type="button" className="step-clear" onClick={() => onSelect(0)} title="取消单牙选中">✕</button>
          )}
        </div>
        <button type="button" className="step-arrow" onClick={() => stepTooth(1)} title="下一颗牙">›</button>
      </div>
    </div>
  );
}
