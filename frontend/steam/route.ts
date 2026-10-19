/** `/library/app/4263274102` (and Big Picture's `/tab/<Name>` variants). */
export function appIdFromPath(pathname: string): number | undefined {
    const match = /^\/library\/app\/(\d+)/.exec(pathname);
    if (!match?.[1]) return undefined;

    const appid = Number(match[1]);
    return Number.isFinite(appid) ? appid : undefined;
}
