# 真·系统鼠标驱动（Windows / ctypes）—— 用于排查"只在真人鼠标下才出现"的问题。
#
# 为什么需要它：CDP 的 Input.dispatchMouseEvent 与 webContents.sendInputEvent 都是**进程内合成**
# 的事件，走不到 OS 那一层（WM_NCHITTEST / 拖拽区 / 焦点激活 / 输入法窗口…）。
# 有些 bug 只在真鼠标路径上出现（例如"从某个方向移进按钮就点不动"），那时只能真的挪光标、真的按键。
# 依赖：只用到 ctypes + user32，不装任何包。
#
# 用法：
#   python test/native-click.py <pid> <clientX> <clientY> <approachDX> <approachDY> <tag>
#     pid        Electron 主进程 pid（注意：同一个进程会有多个 electron.exe，主进程是**不带 --type=** 的那个）
#     clientX/Y  目标在页面里的坐标（CSS px，由页面内探针读 getBoundingClientRect 报出来）
#     approachDX/DY 起点相对目标的偏移（例如 +45,-34 = 从右上方移进来）
#   脚本会先把目标窗口抬到最前并校验 WindowFromPoint 命中的确实是它（否则本次实验无效，直接 ABORT），
#   再分 12 步挪过去、停 1.4 秒、按下抬起，最后把用户原来的光标位置还原。
#
# ⚠️ 会真的占用屏幕和鼠标：实验期间用户的鼠标输入会落到测试窗口上（日志里能靠坐标区分开）。
import ctypes, sys, time, json
from ctypes import wintypes
u = ctypes.windll.user32
k = ctypes.windll.kernel32
u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
u.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
u.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
u.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
u.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
u.WindowFromPoint.argtypes = [wintypes.POINT]; u.WindowFromPoint.restype = wintypes.HWND
u.SetForegroundWindow.argtypes = [wintypes.HWND]
u.BringWindowToTop.argtypes = [wintypes.HWND]
u.SetActiveWindow.argtypes = [wintypes.HWND]
u.GetForegroundWindow.restype = wintypes.HWND
u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
u.GetAncestor.argtypes = [wintypes.HWND, ctypes.c_uint]; u.GetAncestor.restype = wintypes.HWND

pid, cx, cy, adx, ady, tag = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]

found = []
EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
def cb(hwnd, lparam):
    wpid = wintypes.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
    if wpid.value == pid and u.IsWindowVisible(hwnd) and u.GetWindowTextLengthW(hwnd) > 0:
        found.append(hwnd)
    return True
u.EnumWindows(EnumProc(cb), None)
if not found:
    print(json.dumps({'error': 'no window for pid ' + str(pid)})); sys.exit(1)
hwnd = found[0]

origin = wintypes.POINT(0, 0); u.ClientToScreen(hwnd, ctypes.byref(origin))
cr = wintypes.RECT(); u.GetClientRect(hwnd, ctypes.byref(cr))
wr = wintypes.RECT(); u.GetWindowRect(hwnd, ctypes.byref(wr))
px, py = origin.x + cx, origin.y + cy
ax, ay = px + adx, py + ady

# 先把窗口抬到最前并激活 —— 否则真鼠标的输入会落到别的窗口上（这一条不确认的话整场实验无效）
fg0 = u.GetForegroundWindow()
u.ShowWindow(hwnd, 9)                     # SW_RESTORE
u.BringWindowToTop(hwnd)
u.SetForegroundWindow(hwnd)
u.SetActiveWindow(hwnd)
time.sleep(0.7)
fg1 = u.GetForegroundWindow()
under = u.WindowFromPoint(wintypes.POINT(px, py))
under_root = u.GetAncestor(under, 2) if under else None   # GA_ROOT
res = {'tag': tag, 'hwnd': hwnd, 'win': [wr.left, wr.top, wr.right - wr.left, wr.bottom - wr.top],
       'clientOrigin': [origin.x, origin.y], 'clientSize': [cr.right - cr.left, cr.bottom - cr.top],
       'target': [px, py], 'from': [ax, ay],
       'fg_before': fg0, 'fg_after': fg1, 'isForeground': fg1 == hwnd,
       'windowFromPoint_isMine': under_root == hwnd, 'under': under, 'foreignForeground': fg1 != hwnd}
if not res['windowFromPoint_isMine']:
    res['ABORT'] = '目标点上的窗口不是测试实例（被别的窗口压着），这次实验无效'
    print(json.dumps(res, ensure_ascii=False)); sys.exit(0)

orig = wintypes.POINT(); u.GetCursorPos(ctypes.byref(orig))
for i in range(1, 13):
    u.SetCursorPos(int(ax + (px - ax) * i / 12), int(ay + (py - ay) * i / 12))
    time.sleep(0.02)
time.sleep(1.4)                            # 停一下（模拟"移过去、看一眼、再点"）
u.mouse_event(0x0002, 0, 0, 0, 0)
time.sleep(0.06)
u.mouse_event(0x0004, 0, 0, 0, 0)
time.sleep(0.5)
c2 = wintypes.POINT(); u.GetCursorPos(ctypes.byref(c2)); res['cursor_at_click'] = [c2.x, c2.y]
u.SetCursorPos(orig.x, orig.y)
print(json.dumps(res, ensure_ascii=False))
