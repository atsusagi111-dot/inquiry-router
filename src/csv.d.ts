// wrangler.toml の [[rules]] Text により CSV が文字列として import できる。その型宣言
declare module '*.csv' {
  const content: string;
  export default content;
}
