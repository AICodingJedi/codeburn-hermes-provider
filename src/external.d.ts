declare module 'better-sqlite3' {
  interface Database {
    prepare(sql: string): Statement
    close(): void
  }
  interface Statement {
    bind(...params: unknown[]): Statement
    all(): unknown[]
  }
  function Database(path: string, options?: { readonly?: boolean }): Database
  export default Database
}