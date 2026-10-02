import markUrl from './teleoffice-mark.svg'

/** TeleOffice app mark, the rounded brand tile from the product lockup. */
export function TeleOfficeMark({ size = 26 }: { size?: number }) {
  return <img src={markUrl} width={size} height={size} alt="" aria-hidden />
}
