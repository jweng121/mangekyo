import type {ReactNode} from "react";
import {FinanceProvider} from "../../../../finance-dev/app/provider";
export default function Layout({children}:{children:ReactNode}){return <FinanceProvider>{children}</FinanceProvider>;}
