# MindAR → WebAR（WebXR）定位交接  
## 開發說明（Engineering Specification）

**提供對象**：Antigravity 開發團隊  
**文件目的**：規範 MindAR 定位後啟動 WebAR（WebXR）時的安全交接流程，降低 1–2 秒交接期造成的定位誤差風險  
**適用場景**：  
- Marker-based AR 啟動  
- 展覽導覽 / 室內定位輔助  
- WebAR 導航或空間疊加應用  

---

## 1. 背景與問題定義

在使用 **MindAR Image Tracking** 作為初始定位來源，並切換至 **WebXR AR Session** 的過程中，存在一段 **1–2 秒的定位交接期（Transition Window）**。

此期間的技術狀態為：
- MindAR 提供 **camera-relative pose**
- WebXR 尚在建立 **world tracking（SLAM）**
- 使用者可能仍在移動裝置

若未妥善處理，將導致：
- 世界原點偏移（World Origin Misalignment）
- Anchor 建立在錯誤位置
- 旋轉（Yaw / Roll）錯誤
- 後續不可逆的定位漂移

---

## 2. 核心設計原則（Hard Rules）

1. **MindAR 不作為世界座標系**
2. **WebXR 世界座標必須延遲鎖定**
3. **交接期必須視為 Critical Section**
4. **Anchor 建立前，必須限制使用者移動**
5. **不得直接使用 MindAR 的深度（Z）資訊**

---

## 3. 系統狀態機（State Machine）

```text
INIT
 ↓
MINDAR_TRACKING
 ↓
POSE_STABILIZING
 ↓
WEBXR_STARTING
 ↓
WORLD_LOCKING
 ↓
RUNNING

4. 各狀態行為規範

4.1 INIT

目的
	•	初始化 camera、renderer、資源
	•	尚未建立任何世界假設

限制
	•	❌ 不顯示 AR 內容
	•	❌ 不建立 Anchor

⸻

4.2 MINDAR_TRACKING

進入條件
	•	Marker 連續可見 ≥ N 幀（建議 N ≥ 10）

目的
	•	避免單幀誤判
	•	確保 pose 穩定性

⸻

4.3 POSE_STABILIZING（關鍵狀態）

用來處理 1–2 秒高風險交接期

行為
	•	UI 顯示「請保持手機不動」
	•	Freeze 使用者互動
	•	收集 MindAR pose buffer（建議 300–500ms）

技術要求
	•	Pose 必須使用多幀平均
	•	不可使用「最後一幀 pose」
	•	Rotation 建議策略：
	•	保留 yaw
	•	降權或忽略 pitch / roll（依 Marker 方向調整）

⸻

4.4 WEBXR_STARTING

行為
	•	啟動 WebXR AR Session
	•	等待 SLAM 穩定

限制
	•	❌ 不可立即建立 Anchor

進入下一狀態條件
	•	trackingState === "tracked"
	•	XR frame pose 穩定 ≥ 若干幀

⸻

4.5 WORLD_LOCKING

行為
	•	使用 stabilized MindAR pose 作為方向參考
	•	使用 WebXR Hit Test 重算深度
	•	建立第一個 Anchor（作為世界基準）

禁止事項
	•	❌ 直接使用 MindAR 的 Z 值
	•	❌ 在 tracking 未穩定時建立 Anchor

⸻

4.6 RUNNING

狀態說明
	•	WebXR 完全接管 tracking
	•	MindAR 可停止或降頻
	•	顯示正式 AR 內容
	•	啟用互動 / 導航功能

⸻

5. 主要風險與對策
風險               |成因                  |對策
世界原點偏移        |SLAM 尚未收斂          |延遲 Anchor 建立
使用者移動          |pose freeze 不完整    |UI 強制靜止
旋轉錯誤            |座標系定義不一致      |yaw-only 對齊
深度錯誤            |單目視覺限制          |WebXR Hit Test
重新定位跳動         |SLAM re-localization  |Anchor 後延遲顯示

6. Code Review 檢查清單

必須具備
	•	明確 Transition State
	•	Pose buffer averaging
	•	POSE_STABILIZING 期間 UI freeze
	•	Anchor 延遲至 tracking 穩定後建立

不可出現
	•	WebXR 啟動即建立 Anchor
	•	使用 MindAR depth
	•	交接期允許自由移動

⸻

7. 成功判準（Acceptance Criteria）
	•	初始 Anchor 平移誤差 ≤ ±5 cm
	•	初始 yaw 誤差 ≤ ±2°
	•	啟動後 5 秒內：
	•	無可視世界跳動
	•	無整體漂移現象

⸻

8. 備註
	•	本架構定位為 「定位輔助（Localization Aid）」
	•	非完整空間掃描解法
	•	若需求包含：
	•	大範圍空間
	•	長時間高穩定 SLAM
→ 建議評估原生 ARKit / ARCore

---

