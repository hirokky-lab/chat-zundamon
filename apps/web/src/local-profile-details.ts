export type LocalProfileDetails = { occupation: string; region: string };
const key = "zundamon-ai-preview-profile-details";
export function readLocalProfileDetails(): LocalProfileDetails {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    return { occupation: typeof value?.occupation === "string" ? value.occupation.slice(0, 120) : "", region: typeof value?.region === "string" ? value.region.slice(0, 120) : "" };
  } catch { return { occupation: "", region: "" }; }
}
export function saveLocalProfileDetails(value: LocalProfileDetails): void {
  localStorage.setItem(key, JSON.stringify({occupation: value.occupation.trim().slice(0,120), region: value.region.trim().slice(0,120)}));
}
