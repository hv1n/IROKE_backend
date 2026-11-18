// 게시판 표시·필터용 모발 태그: ['중단발', '반곱슬', '손상도 3', '최근 3개월 염색']
import { LENGTH_LABELS, TEXTURE_LABELS, TREATMENT_LABELS, type HairProfile, type TreatmentType } from '../shared';

/** "최근 약제 시술"로 보는 기간 */
export const RECENT_CHEMICAL_DAYS = 90;
const CHEMICAL: TreatmentType[] = ['perm', 'color', 'bleach'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** 라벨의 괄호 설명을 뗀다: '중단발 (어깨)' → '중단발' */
const short = (label: string) => label.replace(/\s*\(.*\)\s*$/, '');

/** RECENT_CHEMICAL_DAYS 안에 한 약제 시술 종류 (펌·염색·탈색 순) */
export function recentChemicals(profile: HairProfile, now: Date): TreatmentType[] {
  return CHEMICAL.filter((type) =>
    profile.history.some((t) => t.type === type && now.getTime() - Date.parse(t.date) <= RECENT_CHEMICAL_DAYS * DAY_MS),
  );
}

export function hairTags(profile: HairProfile, now: Date): string[] {
  return [
    short(LENGTH_LABELS[profile.length]),
    TEXTURE_LABELS[profile.texture],
    `손상도 ${profile.damage}`,
    ...recentChemicals(profile, now).map((t) => `최근 3개월 ${TREATMENT_LABELS[t]}`),
  ];
}
