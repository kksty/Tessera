import { useEffect, useState } from "react";
import { api } from "../api.js";

export function CompatibilityNotice() {
  const [state, setState] = useState<{ incompatible: number; requeued: number } | null>(null);
  useEffect(() => {
    let active = true;
    void api<{ incompatible: number; requeued: number }>("/runtime/compatibility")
      .then((value) => {
        if (active) setState(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (!state || (!state.incompatible && !state.requeued)) return null;
  return (
    <aside role="status" className="compatibility-notice">
      {!!state.incompatible && (
        <p>
          {state.incompatible}{" "}
          个旧格式项目保留在数据库中，当前漏洞库和趋势不包含它们。旧格式没有自动迁移；请先备份并导出旧版本数据，再重建项目，重建后趋势从新项目开始。
        </p>
      )}
      {!!state.requeued && (
        <p>
          {state.requeued} 条历史发现需要按当前分类和证据规则重新审核，通过前不计入已确认漏洞与趋势。
          <a className="compatibility-action" href="#/reviews">
            前往审核队列
          </a>
        </p>
      )}
    </aside>
  );
}
