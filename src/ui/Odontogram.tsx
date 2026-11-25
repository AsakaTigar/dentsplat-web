import { LESION_LABEL } from '../data/cases.ts';

export type ToothMeta = {
  fdi: number;
  arch?: string;
  pos?: number;
  side?: string;
  centroid_mm?: number[];
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

function glyph(upper: boolean) {
  // A tooth silhouette is enough: crown width vs root length roughly follows real ratios.
  return upper
    ? 'M7 2.5 C10 2.5 11.6 4.4 11.6 7.2 C11.6 10 10.6 13.4 9.6 16.2 C9.1 17.5 7.9 17.5 7.6 16.2 C7.2 14.4 6.8 14.4 6.4 16.2 C6.1 17.5 4.9 17.5 4.4 16.2 C3.4 13.4 2.4 10 2.4 7.2 C2.4 4.4 4 2.5 7 2.5 Z'
    : 'M7 1.8 C10 1.8 11.6 3.6 11.6 6.4 C11.6 9.2 10.6 12.6 9.6 15.4 C9.1 16.7 7.9 16.7 7.6 15.4 C7.2 13.6 6.8 13.6 6.4 15.4 C6.1 16.7 4.9 16.7 4.4 15.4 C3.4 12.6 2.4 9.2 2.4 6.4 C2.4 3.6 4 1.8 7 1.8 Z';
}

export default function Odontogram({ teeth, selected, hidden, onSelect, onToggleHide }: Props) {
  const has = (fdi: number) => !!teeth[`FDI_${fdi}`];
  return (
    <div className="odo">
      {ROWS.map((row, ri) => (
        <div className="odo-row" key={ri}>
          <div className="odo-arch">{ri === 0 ? '上颌 MAX' : '下颌 MAN'}</div>
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
              ].join(' ');
              return (
                <button
                  type="button"
                  key={fdi}
                  className={cls}
                  data-fdi={fdi}
                  title={
                    t
                      ? `FDI ${fdi}${lesion ? ' · ' + lesion.cn : ''} · 点击高亮，右键隐藏/恢复`
                      : `FDI ${fdi} · 本场景无该牙`
                  }
                  onClick={() => onSelect(fdi)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onToggleHide(fdi);
                  }}
                >
                  <span className="odo-num">{fdi}</span>
                  <svg viewBox="0 0 14 19" aria-hidden="true">
                    <path d={glyph(ri === 0)} className="odo-shape" />
                  </svg>
                  {lesion && <span className="odo-dot" data-kind={t!.lesion ?? ''} />}
                  {off && <span className="odo-slash" />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="odo-legend">
        <span><i className="lg lg-sel" />当前牙位</span>
        <span><i className="lg lg-car" />龋 / 脱矿 / 牙石</span>
        <span><i className="lg lg-off" />已隐藏（右键切换）</span>
        <span className="odo-hint">点击牙位 = 3D 高亮并聚焦</span>
      </div>
    </div>
  );
}
