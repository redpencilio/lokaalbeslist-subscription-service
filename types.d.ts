declare module '@lblod/mu-auth-sudo' {
    export function updateSudo(queryString: string): object | null;
    export function querySudo(queryString: string): object | null;
}
