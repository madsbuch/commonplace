// Spec: APP-3
/** The Commonplace mark: page edges forming a C, and a ribbon (src/assets/logo.svg). */
import logoUrl from "../assets/logo.svg";

export function Logo(props: { size?: number }) {
  const s = props.size ?? 28;
  return <img src={logoUrl} width={s} height={s} alt="" className="logo" draggable={false} />;
}
