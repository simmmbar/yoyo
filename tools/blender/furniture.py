"""悠悠自習室的原創家具:用 Blender 的 Python 介面建模並匯出成 GLB。

執行:  python tools/blender/furniture.py [輸出資料夾] [只做某幾件…]
需要:  pip install bpy

慣例:單位是公尺;家具正面朝 Blender 的 -Y(匯出後是遊戲裡的 +Z,朝向房間);
原點在佔地中心、底部貼地。材質用名字區分,遊戲端依名字套卡通材質與換色:
wood / woodDark(木頭,可換色)、fabric(布料,可換色)、shade(燈罩,會發光)、
screen(螢幕,遊戲端貼上畫面)、outline(描邊,外擴後翻面的殼)。
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Matrix, Vector, Euler

PALETTE = {
    'wood': '#e6c9a2', 'woodDark': '#b88c63', 'white': '#f7f2e8', 'cream': '#efe3cf',
    'metal': '#9aa0b4', 'dark': '#4d4c60', 'fabric': '#7fa2e6', 'shade': '#fff1d2', 'screen': '#20233a',
    'bezel': '#3b3c50', 'key': '#f7f2e8', 'kbd': '#d5d9e6', 'plant': '#6fbf8a', 'pot': '#dc9470',
    'brass': '#e3b25e', 'cardboard': '#d6a878', 'glass': '#cfe6f2', 'pink': '#f2a7b5', 'red': '#e2726f', 'soil': '#6b4e3d',
    'sky': '#bfe0f5', 'art': '#f2d9b0', 'poster': '#c45c8a', 'mirror': '#d9ecf5', 'fabric2': '#f1b6a8',
    'bookA': '#e79aa5', 'bookB': '#f2c078', 'bookC': '#9ccfa4', 'bookD': '#8fb7e3', 'bookE': '#b7a3e0', 'bookF': '#f4efe6',
    'outline': '#5b4638',
}
OUTLINE = 0.0045  # 描邊厚度(公尺)


def lin(hexcol):
    c = [int(hexcol[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c] + [1.0]


class Model:
    def __init__(self, name):
        self.name, self.bm, self.ol, self.mats = name, bmesh.new(), bmesh.new(), []
        self.uv = self.bm.loops.layers.uv.new('UVMap')

    def mat(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def _merge(self, tmp, mat, loc, rot, outline, dims=(1, 1, 1)):
        """把暫存的形狀轉到定位、指定材質,併入模型(需要描邊的另存一份)。

        同時替零件加上貼圖座標(單位是公尺):每個面照它朝向的那一軸做平面投影,
        u 軸取零件最長的那一邊,木紋才會順著桌腳、層板的長向走。每個零件隨機偏移,紋路才不會一模一樣。
        """
        uv = tmp.loops.layers.uv.new('UVMap')
        tmp.normal_update()
        self.parts = getattr(self, 'parts', 0) + 1
        ou, ov = (self.parts * 0.37) % 1.0, (self.parts * 0.61) % 1.0
        grain = max(range(3), key=lambda i: dims[i])
        for f in tmp.faces:
            a = max(range(3), key=lambda i: abs(f.normal[i]))
            plane = [i for i in range(3) if i != a]
            u_ax = grain if grain in plane else max(plane, key=lambda i: dims[i])
            v_ax = plane[0] if plane[1] == u_ax else plane[1]
            for l in f.loops:
                l[uv].uv = (l.vert.co[u_ax] + ou, l.vert.co[v_ax] + ov)
        M = Matrix.Translation(Vector(loc)) @ Euler(rot, 'XYZ').to_matrix().to_4x4()
        bmesh.ops.transform(tmp, matrix=M, verts=tmp.verts)
        idx = self.mat(mat)
        for f in tmp.faces:
            f.material_index = idx
            f.smooth = True
        me = bpy.data.meshes.new('tmp')
        tmp.to_mesh(me)
        self.bm.from_mesh(me)
        if outline:
            self.ol.from_mesh(me)
        bpy.data.meshes.remove(me)
        tmp.free()

    def box(self, size, loc, mat, bevel=0.012, seg=2, rot=(0, 0, 0), outline=True):
        """圓角方塊。loc 是中心。"""
        tmp = bmesh.new()
        bmesh.ops.create_cube(tmp, size=1.0)
        bmesh.ops.scale(tmp, vec=Vector(size), verts=tmp.verts)
        b = min(bevel, min(size) * 0.49)
        if b > 0.0005:
            bmesh.ops.bevel(tmp, geom=tmp.edges[:], offset=b, segments=seg, profile=0.5, affect='EDGES')
        self._merge(tmp, mat, loc, rot, outline, dims=size)

    def cyl(self, r1, r2, depth, loc, mat, segs=28, rot=(0, 0, 0), bevel=0.0, outline=True):
        """圓柱或圓錐台,軸向為 Z。r1 是底部半徑、r2 是頂部半徑。"""
        tmp = bmesh.new()
        bmesh.ops.create_cone(tmp, cap_ends=True, cap_tris=False, segments=segs, radius1=r1, radius2=r2, depth=depth)
        if bevel > 0.0005:
            rim = [e for e in tmp.edges if abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-6]
            bmesh.ops.bevel(tmp, geom=rim, offset=min(bevel, depth * 0.45), segments=2, profile=0.5, affect='EDGES')
        self._merge(tmp, mat, loc, rot, outline, dims=(max(r1, r2) * 2, max(r1, r2) * 2, depth))

    def ball(self, r, loc, mat, scale=(1, 1, 1), rot=(0, 0, 0), outline=True):
        tmp = bmesh.new()
        bmesh.ops.create_uvsphere(tmp, u_segments=20, v_segments=12, radius=r)
        bmesh.ops.scale(tmp, vec=Vector(scale), verts=tmp.verts)
        self._merge(tmp, mat, loc, rot, outline, dims=tuple(r * 2 * k for k in scale))

    def quad(self, w, h, loc, mat, rot=(0, 0, 0), uv=((0, 0), (1, 0), (1, 1), (0, 1))):
        """朝 -Y 的平面,預設 UV 鋪滿 0–1(螢幕、窗景、掛畫用,遊戲端貼圖)。"""
        vs = [self.bm.verts.new(Euler(rot, 'XYZ').to_matrix() @ Vector(p) + Vector(loc))
              for p in ((-w / 2, 0, -h / 2), (w / 2, 0, -h / 2), (w / 2, 0, h / 2), (-w / 2, 0, h / 2))]
        f = self.bm.faces.new(vs)
        f.material_index = self.mat(mat)
        for loop, co in zip(f.loops, uv):
            loop[self.uv].uv = co

    def export(self, outdir):
        # 描邊:把需要描邊的部分沿法線外擴一點、翻面,用深色不受光的材質畫出輪廓線
        self.ol.normal_update()
        for v in self.ol.verts:
            v.co += v.normal * OUTLINE
        bmesh.ops.reverse_faces(self.ol, faces=self.ol.faces[:])
        ol_uv = self.ol.loops.layers.uv.get('UVMap')
        if ol_uv:  # 描邊不需要貼圖座標,歸零讓頂點可以合併、檔案比較小
            for f in self.ol.faces:
                for l in f.loops:
                    l[ol_uv].uv = (0, 0)
        oi = self.mat('outline')
        for f in self.ol.faces:
            f.material_index = oi
        me = bpy.data.meshes.new('ol')
        self.ol.to_mesh(me)
        self.bm.from_mesh(me)
        bpy.data.meshes.remove(me)

        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        for n in self.mats:
            m = bpy.data.materials.get(n) or bpy.data.materials.new(n)
            m.use_nodes = True
            bsdf = m.node_tree.nodes.get('Principled BSDF')
            bsdf.inputs['Base Color'].default_value = lin(PALETTE[n])
            bsdf.inputs['Roughness'].default_value = 0.9
            mesh.materials.append(m)
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        # 讓大平面保持平整、只有圓角帶出高光
        wn = obj.modifiers.new('wn', 'WEIGHTED_NORMAL')
        wn.keep_sharp = False
        wn.weight = 100
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        path = os.path.join(outdir, self.name + '.glb')
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                                  export_apply=True, export_normals=True, export_texcoords=True, export_materials='EXPORT')
        tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
        bb = [(min(v.co[i] for v in mesh.vertices), max(v.co[i] for v in mesh.vertices)) for i in range(3)]
        print(f'{self.name}: {tris} tris, {os.path.getsize(path) // 1024} KB, size '
              + ' x '.join(f'{b - a:.2f}' for a, b in bb))
        bpy.data.objects.remove(obj)
        self.bm.free(); self.ol.free()


# ---------------------------------------------------------------- 家具

def desk():
    """工作桌 1.5 × 0.7,高 0.74:右側三層抽屜櫃,左側板腳。正面(-Y)是坐人的那一側。"""
    m = Model('desk')
    W, D, H, T = 1.5, 0.7, 0.74, 0.04
    m.box((W, D, T), (0, 0, H - T / 2), 'wood', bevel=0.014)                       # 桌面
    m.box((0.035, D - 0.08, H - T), (-W / 2 + 0.05, 0, (H - T) / 2), 'wood')       # 左板腳
    m.box((W - 0.5, 0.025, 0.3), (-0.2, D / 2 - 0.07, H - T - 0.16), 'wood')       # 後擋板
    px, pw = W / 2 - 0.24, 0.4                                                     # 抽屜櫃
    m.box((pw, D - 0.08, H - T - 0.06), (px, 0, 0.06 + (H - T - 0.06) / 2), 'wood')
    for k, (z, hh) in enumerate(((0.585, 0.14), (0.43, 0.14), (0.215, 0.26))):
        m.box((pw - 0.04, 0.02, hh), (px, -D / 2 + 0.035, z), 'white', bevel=0.008)   # 抽屜面板
        m.box((0.11, 0.018, 0.016), (px, -D / 2 + 0.02, z + hh / 2 - 0.035), 'woodDark', bevel=0.006)  # 把手
    for sx in (-0.15, 0.15):                                                       # 櫃腳
        for sy in (-0.24, 0.24):
            m.cyl(0.018, 0.022, 0.06, (px + sx, sy, 0.03), 'woodDark', segs=12, outline=False)
    m.box((0.5, 0.012, 0.012), (-0.2, D / 2 - 0.085, H - T - 0.33), 'woodDark', bevel=0.004, outline=False)  # 理線桿
    return m


def chair():
    """電腦椅:五爪腳、氣壓桿、厚坐墊、微微後仰的椅背、扶手。座面高約 0.48,正面朝 -Y。"""
    m = Model('chair')
    for i in range(5):                                                             # 五爪腳與輪子
        a = math.radians(i * 72 + 18)
        dx, dy = math.cos(a), math.sin(a)
        m.box((0.30, 0.045, 0.03), (dx * 0.15, dy * 0.15, 0.085), 'dark', bevel=0.012, rot=(0, 0, a))
        m.ball(0.032, (dx * 0.29, dy * 0.29, 0.034), 'dark', scale=(1, 1, 1.05), outline=False)
    m.cyl(0.05, 0.04, 0.05, (0, 0, 0.1), 'dark', segs=16)
    m.cyl(0.022, 0.022, 0.26, (0, 0, 0.24), 'metal', segs=14)                      # 氣壓桿
    m.box((0.2, 0.2, 0.04), (0, 0, 0.385), 'dark', bevel=0.012)                    # 座椅底盤
    m.box((0.48, 0.47, 0.09), (0, -0.01, 0.45), 'fabric', bevel=0.04, seg=4)       # 坐墊
    m.box((0.06, 0.035, 0.34), (0, 0.235, 0.56), 'dark', bevel=0.012, rot=(-0.12, 0, 0))  # 椅背支架
    m.box((0.44, 0.075, 0.5), (0, 0.255, 0.84), 'fabric', bevel=0.035, seg=4, rot=(-0.14, 0, 0))  # 椅背
    for sx in (-1, 1):                                                             # 扶手
        m.box((0.03, 0.03, 0.2), (sx * 0.255, 0.03, 0.53), 'dark', bevel=0.01)
        m.box((0.05, 0.24, 0.03), (sx * 0.255, 0.0, 0.64), 'dark', bevel=0.013)
    return m


def bookcase():
    """開放書櫃 0.8 × 0.32,高 1.8:四層,放滿書、一個收納盒和小盆栽。背面貼牆。"""
    m = Model('bookcase')
    rnd = random.Random(7)
    W, D, H, T = 0.8, 0.32, 1.8, 0.028
    for sx in (-1, 1):
        m.box((T, D, H), (sx * (W / 2 - T / 2), 0, H / 2), 'wood')
    m.box((W - 2 * T, 0.012, H - 0.08), (0, D / 2 - 0.01, H / 2 + 0.03), 'cream', bevel=0.003, outline=False)  # 背板
    levels = [0.07, 0.47, 0.87, 1.27, H - T / 2]
    for z in levels:
        m.box((W - 2 * T + 0.004, D - 0.01, T), (0, 0, z), 'wood')
    m.box((W - 2 * T, 0.02, 0.055), (0, -D / 2 + 0.03, 0.03), 'woodDark', bevel=0.006)  # 踢腳板
    cols = ['bookA', 'bookB', 'bookC', 'bookD', 'bookE', 'bookF']
    inner = W - 2 * T - 0.03

    def row(z0, x0, x1, lean=True):
        x = x0
        while x < x1 - 0.02:
            t = rnd.uniform(0.022, 0.05)
            if x + t > x1:
                break
            hh, dd = rnd.uniform(0.19, 0.29), rnd.uniform(0.17, 0.22)
            tilt = 0.0
            if lean and x + t > x1 - 0.07 and rnd.random() < 0.7:      # 最後一本斜靠
                tilt = 0.22
            m.box((t, dd, hh), (x + t / 2 + math.sin(tilt) * hh / 2, -D / 2 + 0.035 + dd / 2, z0 + hh / 2 * math.cos(tilt)),
                  rnd.choice(cols), bevel=0.004, seg=1, rot=(0, tilt, 0))
            x += t + 0.002 + math.sin(tilt) * hh

    z = [l + T / 2 for l in levels[:-1]]
    row(z[3], -inner / 2, inner / 2 - 0.2)                                         # 最上層:書 + 盆栽
    m.cyl(0.045, 0.058, 0.09, (inner / 2 - 0.09, -0.02, z[3] + 0.045), 'pot', segs=16, bevel=0.008)
    for i in range(7):
        a = i * 0.9
        m.ball(0.04, (inner / 2 - 0.09 + math.cos(a) * 0.035, -0.02 + math.sin(a) * 0.035, z[3] + 0.12 + (i % 3) * 0.03),
               'plant', scale=(0.75, 0.75, 1.5), outline=False)
    row(z[2], -inner / 2, inner / 2)                                               # 第三層:整排書
    row(z[1], -inner / 2 + 0.3, inner / 2)                                         # 第二層:橫放的書 + 一排書
    zz = z[1]
    for k in range(3):
        t = rnd.uniform(0.03, 0.045)
        m.box((0.2, 0.26 - k * 0.012, t), (-inner / 2 + 0.13, -0.01, zz + t / 2), rnd.choice(cols), bevel=0.004, seg=1,
              rot=(0, 0, rnd.uniform(-0.12, 0.12)))
        zz += t + 0.001
    m.box((0.34, 0.25, 0.24), (-inner / 2 + 0.19, -0.015, z[0] + 0.12), 'cream', bevel=0.02, seg=3)   # 最下層:收納盒 + 書
    m.box((0.09, 0.012, 0.03), (-inner / 2 + 0.19, -0.145, z[0] + 0.17), 'woodDark', bevel=0.005, outline=False)
    row(z[0], -inner / 2 + 0.4, inner / 2)
    return m


def lamp():
    """檯燈,高約 0.44:圓底座、細燈桿、布燈罩(遊戲端會讓燈罩發光)。"""
    m = Model('lamp')
    m.cyl(0.085, 0.075, 0.022, (0, 0, 0.011), 'woodDark', segs=28, bevel=0.007)
    m.cyl(0.012, 0.012, 0.25, (0, 0, 0.145), 'metal', segs=12)
    m.ball(0.02, (0, 0, 0.275), 'metal', outline=False)
    m.cyl(0.125, 0.085, 0.17, (0, 0, 0.355), 'shade', segs=32, bevel=0.006)
    m.cyl(0.126, 0.126, 0.012, (0, 0, 0.272), 'cream', segs=32, outline=False)     # 燈罩下緣的滾邊
    return m


def monitor():
    """螢幕 + 鍵盤 + 滑鼠 + 馬克杯。佔 1 × 1 格,螢幕在後、鍵盤在前(-Y)。"""
    m = Model('monitor')
    # 螢幕
    sw, sh, sy, sz = 0.60, 0.36, 0.14, 0.32
    m.cyl(0.1, 0.1, 0.012, (0, sy + 0.02, 0.006), 'bezel', segs=28, bevel=0.004)
    m.box((0.04, 0.03, 0.2), (0, sy + 0.035, 0.11), 'bezel', bevel=0.01)
    m.box((sw, 0.028, sh), (0, sy, sz), 'bezel', bevel=0.012, seg=3)
    m.box((sw - 0.03, 0.006, sh - 0.03), (0, sy - 0.014, sz), 'screen', bevel=0.004, outline=False)
    m.quad(sw - 0.04, sh - 0.04, (0, sy - 0.0185, sz), 'screen')
    # 鍵盤
    kw, kd, ky = 0.36, 0.13, -0.2
    m.box((kw, kd, 0.016), (-0.05, ky, 0.008), 'kbd', bevel=0.006)
    rows, cols = 4, 13
    for r in range(rows):
        for c in range(cols):
            if r == rows - 1 and 3 <= c <= 8:
                continue
            m.box((0.021, 0.021, 0.008), (-0.05 - kw / 2 + 0.024 + c * 0.026, ky + kd / 2 - 0.022 - r * 0.027, 0.02),
                  'key', bevel=0.003, seg=1, outline=False)
    m.box((0.15, 0.021, 0.008), (-0.05 - kw / 2 + 0.024 + 5.5 * 0.026, ky + kd / 2 - 0.022 - 3 * 0.027, 0.02), 'key',
          bevel=0.003, seg=1, outline=False)                                       # 空白鍵
    # 滑鼠墊與滑鼠
    m.box((0.2, 0.17, 0.004), (0.3, ky, 0.002), 'dark', bevel=0.0015, outline=False)
    m.ball(0.034, (0.3, ky, 0.017), 'white', scale=(0.85, 1.35, 0.5))
    # 馬克杯
    m.cyl(0.036, 0.04, 0.085, (-0.36, -0.05, 0.0425), 'fabric', segs=20, bevel=0.006)
    m.cyl(0.031, 0.031, 0.004, (-0.36, -0.05, 0.083), 'woodDark', segs=20, outline=False)
    m.box((0.012, 0.03, 0.045), (-0.405, -0.05, 0.045), 'fabric', bevel=0.005, outline=False)
    return m


BOOKS = ['bookA', 'bookB', 'bookC', 'bookD', 'bookE', 'bookF']
X90 = (math.pi / 2, 0, 0)   # 把 Z 軸的圓柱轉成朝前後(Y 軸)
Y90 = (0, math.pi / 2, 0)   # 轉成朝左右(X 軸)


def book_row(m, rnd, x0, x1, yfront, z0, hmax=0.29, lean=True):
    """在 x0–x1 之間排一排直立的書,書背對齊 yfront(-Y 側)。"""
    x = x0
    while x < x1 - 0.02:
        t = rnd.uniform(0.022, 0.05)
        if x + t > x1:
            break
        hh, dd = rnd.uniform(hmax * 0.66, hmax), rnd.uniform(0.15, 0.2)
        tilt = 0.22 if (lean and x + t > x1 - 0.07 and rnd.random() < 0.7) else 0.0
        m.box((t, dd, hh), (x + t / 2 + math.sin(tilt) * hh / 2, yfront + dd / 2, z0 + hh / 2 * math.cos(tilt)),
              rnd.choice(BOOKS), bevel=0.004, seg=1, rot=(0, tilt, 0))
        x += t + 0.002 + math.sin(tilt) * hh


def potted(m, x, y, z, r=0.05, h=0.08, leaves=6, leaf=0.045, mat='plant', outline=True):
    """小盆栽:陶盆 + 一圈葉子。"""
    m.cyl(r * 0.8, r, h, (x, y, z + h / 2), 'pot', segs=16, bevel=h * 0.08, outline=outline)
    for i in range(leaves):
        a = i * 2 * math.pi / leaves + 0.4
        k = 0.55 + (i % 2) * 0.35
        m.ball(leaf, (x + math.cos(a) * r * k, y + math.sin(a) * r * k, z + h + leaf * (1.0 + (i % 3) * 0.35)),
               mat, scale=(0.7, 0.7, 1.6), rot=(math.sin(a) * -0.5, math.cos(a) * 0.5, 0), outline=outline)


# ---------------- 房間的殼:窗、門、掛畫、海報、時鐘、壁飾(背面貼牆,牆面在 Y=0,往 -Y 突出) ----------------

def window():
    """雙扇窗 1.7 × 1.25,窗台高 1.0:白窗框、窗台、窗簾與窗簾桿、窗台上的小盆栽。窗景由遊戲端貼圖。"""
    m = Model('window')
    W, H, z0, f = 1.7, 1.25, 1.0, 0.07
    m.quad(W - 0.06, H - 0.06, (0, -0.012, z0 + H / 2), 'sky', uv=((0, 0.1), (1, 0.1), (1, 0.9), (0, 0.9)))
    for sx in (-1, 1):
        m.box((f, f, H), (sx * (W / 2 - f / 2), -f / 2, z0 + H / 2), 'white')
    for z in (z0 + f / 2, z0 + H - f / 2):
        m.box((W, f, f), (0, -f / 2, z), 'white')
    m.box((0.045, 0.05, H - f), (0, -0.035, z0 + H / 2), 'white', bevel=0.008)                 # 中柱
    m.box((W - f, 0.04, 0.03), (0, -0.035, z0 + H * 0.62), 'white', bevel=0.006, outline=False)  # 橫格
    m.box((W + 0.18, 0.16, 0.04), (0, -0.08, z0 - 0.02), 'white', bevel=0.012)                 # 窗台
    m.cyl(0.013, 0.013, W + 0.5, (0, -0.11, z0 + H + 0.1), 'woodDark', segs=10, rot=Y90)       # 窗簾桿
    for sx in (-1, 1):
        m.ball(0.028, (sx * (W / 2 + 0.25), -0.11, z0 + H + 0.1), 'woodDark')
        for k in range(5):                                                                    # 收在兩側的窗簾皺褶
            x = sx * (W / 2 + 0.2 - k * 0.062)
            m.cyl(0.04, 0.036, H + 0.34, (x, -0.11 - (k % 2) * 0.012, z0 + H / 2 - 0.07), 'fabric', segs=10)
    potted(m, -W / 2 + 0.28, -0.1, z0, r=0.05, h=0.075, leaves=6)
    return m


def door():
    """房門:白門框、木門板(上下兩格)、黃銅門把。正面朝 -Y。"""
    m = Model('door')
    W, H = 0.92, 2.08
    for sx in (-1, 1):
        m.box((0.08, 0.06, H + 0.06), (sx * (W / 2 + 0.04), -0.03, (H + 0.06) / 2), 'white')
    m.box((W + 0.16, 0.06, 0.08), (0, -0.03, H + 0.06), 'white')
    m.box((W, 0.04, H), (0, -0.03, H / 2), 'wood', bevel=0.008)
    for z, hh in ((1.5, 0.9), (0.52, 0.72)):
        m.box((W - 0.22, 0.012, hh), (0, -0.054, z), 'wood', bevel=0.012)
    m.cyl(0.03, 0.03, 0.012, (-W / 2 + 0.09, -0.058, 1.02), 'brass', segs=16, rot=X90, outline=False)
    m.ball(0.032, (-W / 2 + 0.09, -0.095, 1.02), 'brass')
    return m


def frame():
    """掛畫:木框 + 襯紙,畫作由遊戲端貼圖。"""
    m = Model('frame')
    W, H, z, f = 0.62, 0.78, 1.78, 0.05
    m.box((W - 0.02, 0.012, H - 0.02), (0, -0.01, z), 'cream', bevel=0.003, outline=False)
    m.quad(W - 0.2, H - 0.2, (0, -0.0175, z), 'art')
    for sx in (-1, 1):
        m.box((f, 0.035, H), (sx * (W / 2 - f / 2), -0.0175, z), 'wood', bevel=0.008)
    for sz in (-1, 1):
        m.box((W, 0.035, f), (0, -0.0175, z + sz * (H / 2 - f / 2)), 'wood', bevel=0.008)
    return m


def poster():
    """海報:上下兩根木條夾著一張紙,圖案由遊戲端貼圖。"""
    m = Model('poster')
    W, H, z = 0.6, 0.84, 1.8
    m.box((W, 0.004, H), (0, -0.004, z), 'white', bevel=0.0, outline=False)
    m.quad(W - 0.02, H - 0.02, (0, -0.0065, z), 'poster')
    for sz in (-1, 1):
        m.box((W + 0.05, 0.016, 0.032), (0, -0.01, z + sz * H / 2), 'woodDark', bevel=0.006)
    return m


def clock():
    """圓形掛鐘(指針由遊戲端依現在時間畫上去)。鐘面中心高 2.15。"""
    m = Model('clock')
    z = 2.15
    m.cyl(0.2, 0.2, 0.05, (0, -0.025, z), 'woodDark', segs=40, rot=X90, bevel=0.012)
    m.cyl(0.172, 0.172, 0.012, (0, -0.052, z), 'white', segs=40, rot=X90, outline=False)
    for i in range(12):
        a = i * math.pi / 6
        big = i % 3 == 0
        m.box((0.012 if big else 0.007, 0.004, 0.034 if big else 0.02),
              (math.sin(a) * 0.142, -0.059, z + math.cos(a) * 0.142), 'dark', bevel=0.0, rot=(0, -a, 0), outline=False)
    return m


def wallshelf():
    """壁掛層板 1.5 寬,高度 1.85:兩個托架、一排書、相框、小盆栽。"""
    m = Model('wallshelf')
    rnd = random.Random(21)
    z = 1.85
    m.box((1.5, 0.22, 0.03), (0, -0.11, z), 'wood')
    for sx in (-0.55, 0.55):
        m.box((0.03, 0.18, 0.03), (sx, -0.1, z - 0.03), 'woodDark', bevel=0.008, outline=False)
        m.box((0.03, 0.03, 0.16), (sx, -0.02, z - 0.09), 'woodDark', bevel=0.008)
    book_row(m, rnd, -0.68, -0.05, -0.2, z + 0.015, hmax=0.26)
    m.box((0.2, 0.02, 0.26), (0.2, -0.07, z + 0.145), 'woodDark', bevel=0.008, rot=(0.12, 0, 0))   # 相框
    m.box((0.15, 0.006, 0.21), (0.2, -0.083, z + 0.145), 'cream', bevel=0.002, rot=(0.12, 0, 0), outline=False)
    potted(m, 0.55, -0.11, z + 0.015, r=0.055, h=0.08, leaves=7)
    return m


def walllamp():
    """壁燈:底座、彎臂、朝下的燈罩。"""
    m = Model('walllamp')
    z = 2.05
    m.cyl(0.06, 0.06, 0.02, (0, -0.01, z), 'woodDark', segs=20, rot=X90, bevel=0.006)
    m.cyl(0.011, 0.011, 0.16, (0, -0.09, z), 'metal', segs=10, rot=X90)
    m.cyl(0.011, 0.011, 0.08, (0, -0.17, z + 0.035), 'metal', segs=10, outline=False)
    m.cyl(0.11, 0.05, 0.13, (0, -0.17, z - 0.03), 'shade', segs=28, bevel=0.006)
    return m


def mirror():
    """圓角落地感的壁鏡:木框 + 鏡面 + 兩道反光。"""
    m = Model('mirror')
    W, H, z = 0.5, 1.1, 1.45
    m.box((W, 0.03, H), (0, -0.015, z), 'wood', bevel=0.06, seg=4)
    m.box((W - 0.07, 0.008, H - 0.07), (0, -0.031, z), 'mirror', bevel=0.045, seg=4, outline=False)
    for dx, ww in ((-0.06, 0.05), (0.03, 0.022)):
        m.box((ww, 0.002, 0.5), (dx, -0.0365, z + 0.1), 'white', bevel=0.0, rot=(0, 0.5, 0), outline=False)
    return m


# ---------------- 桌椅 ----------------

def dchair():
    """木椅 + 布坐墊。座面高約 0.47,正面朝 -Y。"""
    m = Model('dchair')
    for sx in (-1, 1):
        m.box((0.038, 0.038, 0.44), (sx * 0.18, -0.17, 0.22), 'wood', bevel=0.01)
        m.box((0.038, 0.038, 0.92), (sx * 0.18, 0.18, 0.46), 'wood', bevel=0.01)
    m.box((0.43, 0.42, 0.03), (0, 0.0, 0.44), 'wood', bevel=0.01)
    m.box((0.39, 0.37, 0.045), (0, -0.01, 0.475), 'fabric', bevel=0.02, seg=3)
    m.box((0.4, 0.028, 0.11), (0, 0.18, 0.85), 'wood', bevel=0.012)
    for dx in (-0.09, 0.0, 0.09):
        m.box((0.03, 0.02, 0.3), (dx, 0.18, 0.64), 'wood', bevel=0.007, outline=False)
    m.box((0.36, 0.022, 0.03), (0, 0.18, 0.5), 'wood', bevel=0.007, outline=False)
    return m


def stool():
    """圓凳:布坐墊、三支外撇的木腳、一圈橫桿。座面高 0.45。"""
    m = Model('stool')
    m.cyl(0.17, 0.17, 0.03, (0, 0, 0.405), 'wood', segs=28, bevel=0.008)
    m.cyl(0.165, 0.16, 0.045, (0, 0, 0.44), 'fabric', segs=28, bevel=0.018)
    for i in range(3):
        a = i * 2 * math.pi / 3 + 0.5
        m.cyl(0.02, 0.016, 0.42, (math.cos(a) * 0.13, math.sin(a) * 0.13, 0.2), 'wood', segs=10,
              rot=(math.sin(a) * 0.17, -math.cos(a) * 0.17, 0))
    m.cyl(0.115, 0.115, 0.016, (0, 0, 0.16), 'woodDark', segs=20, outline=False)
    return m


def table():
    """長桌 1.6 × 0.8,高 0.74。"""
    m = Model('table')
    m.box((1.6, 0.8, 0.04), (0, 0, 0.72), 'wood', bevel=0.015)
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.box((0.055, 0.055, 0.7), (sx * 0.72, sy * 0.32, 0.35), 'wood', bevel=0.012)
        m.box((0.03, 0.6, 0.07), (sx * 0.72, 0, 0.655), 'wood', bevel=0.008, outline=False)
    for sy in (-1, 1):
        m.box((1.4, 0.03, 0.07), (0, sy * 0.32, 0.655), 'wood', bevel=0.008, outline=False)
    return m


def coffee():
    """茶几 1.1 × 0.55,高 0.4,下層有置物板和兩本雜誌。"""
    m = Model('coffee')
    m.box((1.1, 0.55, 0.035), (0, 0, 0.3825), 'wood', bevel=0.016)
    m.box((0.96, 0.43, 0.022), (0, 0, 0.14), 'wood', bevel=0.008)
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.box((0.045, 0.045, 0.37), (sx * 0.49, sy * 0.22, 0.185), 'woodDark', bevel=0.012)
    m.box((0.24, 0.3, 0.014), (-0.2, 0, 0.158), 'bookD', bevel=0.004, seg=1, rot=(0, 0, 0.15), outline=False)
    m.box((0.22, 0.29, 0.014), (-0.19, 0.01, 0.172), 'bookA', bevel=0.004, seg=1, rot=(0, 0, -0.1))
    return m


def side():
    """邊桌/床頭櫃 0.5 × 0.42,高 0.52:一個抽屜、下方開放格放書。"""
    m = Model('side')
    rnd = random.Random(3)
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.cyl(0.018, 0.014, 0.1, (sx * 0.2, sy * 0.16, 0.05), 'woodDark', segs=10, outline=False)
    m.box((0.5, 0.42, 0.42), (0, 0, 0.31), 'wood', bevel=0.018)
    m.box((0.43, 0.02, 0.14), (0, -0.205, 0.42), 'white', bevel=0.008)
    m.cyl(0.016, 0.016, 0.02, (0, -0.225, 0.42), 'brass', segs=12, rot=X90, outline=False)
    m.box((0.43, 0.3, 0.2), (0, -0.07, 0.22), 'woodDark', bevel=0.004, outline=False)      # 開放格(內凹的深色)
    book_row(m, rnd, -0.19, 0.08, -0.2, 0.125, hmax=0.17, lean=True)
    return m


# ---------------- 收納 ----------------

def cabinet():
    """門片書櫃 0.8 × 0.36,高 1.8:下半兩扇白門,上半兩層開放格。"""
    m = Model('cabinet')
    rnd = random.Random(11)
    W, D, H, T = 0.8, 0.36, 1.8, 0.028
    for sx in (-1, 1):
        m.box((T, D, H), (sx * (W / 2 - T / 2), 0, H / 2), 'wood')
    m.box((W - 2 * T, 0.012, H - 0.08), (0, D / 2 - 0.01, H / 2 + 0.03), 'cream', bevel=0.003, outline=False)
    for z in (0.07, 0.95, 1.36, H - T / 2):
        m.box((W - 2 * T + 0.004, D - 0.01, T), (0, 0, z), 'wood')
    m.box((W - 2 * T, 0.02, 0.055), (0, -D / 2 + 0.03, 0.03), 'woodDark', bevel=0.006)
    for sx in (-1, 1):
        m.box((W / 2 - T - 0.006, 0.02, 0.84), (sx * (W / 4 - T / 2 + 0.002), -D / 2 + 0.012, 0.51), 'white', bevel=0.01)
        m.box((0.016, 0.018, 0.12), (sx * 0.04, -D / 2 - 0.004, 0.62), 'woodDark', bevel=0.006)
    inner = W - 2 * T - 0.03
    book_row(m, rnd, -inner / 2, inner / 2 - 0.22, -D / 2 + 0.035, 0.964)
    m.box((0.18, 0.2, 0.16), (inner / 2 - 0.1, -0.02, 1.044), 'cream', bevel=0.016, seg=3)
    book_row(m, rnd, -inner / 2 + 0.2, inner / 2, -D / 2 + 0.035, 1.374)
    potted(m, -inner / 2 + 0.09, -0.03, 1.374, r=0.05, h=0.075, leaves=6)
    return m


def sideboard():
    """寬矮櫃 1.7 × 0.38,高 0.95:左邊門片、中間開放格、右邊三層抽屜,短腳。"""
    m = Model('sideboard')
    rnd = random.Random(5)
    W, D, H, z0 = 1.7, 0.38, 0.95, 0.12
    for sx in (-0.75, 0.75):
        for sy in (-0.13, 0.13):
            m.cyl(0.022, 0.016, z0, (sx, sy, z0 / 2), 'woodDark', segs=10, outline=False)
    m.box((W, D, H - z0), (0, 0, z0 + (H - z0) / 2), 'wood', bevel=0.02)
    yf = -D / 2 + 0.006
    for sx in (-1, 1):                                                                # 左:兩扇門
        m.box((0.255, 0.02, H - z0 - 0.08), (-0.56 + sx * 0.132, yf, z0 + (H - z0) / 2), 'white', bevel=0.01)
        m.box((0.014, 0.018, 0.1), (-0.56 + sx * 0.03, yf - 0.014, z0 + (H - z0) / 2 + 0.1), 'woodDark', bevel=0.005, outline=False)
    m.box((0.52, 0.3, H - z0 - 0.08), (0, yf + 0.13, z0 + (H - z0) / 2), 'woodDark', bevel=0.004, outline=False)  # 中:開放格
    m.box((0.52, 0.3, 0.022), (0, yf + 0.14, z0 + 0.4), 'wood', bevel=0.006, outline=False)
    book_row(m, rnd, -0.24, 0.24, yf + 0.02, z0 + 0.04, hmax=0.27)
    book_row(m, rnd, -0.24, 0.05, yf + 0.02, z0 + 0.411, hmax=0.25)
    m.box((0.15, 0.17, 0.13), (0.16, yf + 0.11, z0 + 0.476), 'cream', bevel=0.014, seg=3)
    for k in range(3):                                                                # 右:抽屜
        z = z0 + 0.04 + 0.118 + k * 0.245
        m.box((0.5, 0.02, 0.225), (0.56, yf, z), 'white', bevel=0.01)
        m.box((0.12, 0.018, 0.016), (0.56, yf - 0.014, z + 0.06), 'woodDark', bevel=0.005, outline=False)
    return m


def lowcase():
    """矮櫃 0.8 × 0.36,高 0.75:兩層開放格,書和收納盒。"""
    m = Model('lowcase')
    rnd = random.Random(9)
    W, D, H, T = 0.8, 0.36, 0.75, 0.028
    for sx in (-1, 1):
        m.box((T, D, H), (sx * (W / 2 - T / 2), 0, H / 2), 'wood')
    m.box((W - 2 * T, 0.012, H - 0.08), (0, D / 2 - 0.01, H / 2 + 0.03), 'cream', bevel=0.003, outline=False)
    for z in (0.07, 0.4, H - T / 2):
        m.box((W - 2 * T + 0.004, D - 0.01, T), (0, 0, z), 'wood')
    m.box((W - 2 * T, 0.02, 0.055), (0, -D / 2 + 0.03, 0.03), 'woodDark', bevel=0.006)
    inner = W - 2 * T - 0.03
    book_row(m, rnd, -inner / 2, inner / 2 - 0.02, -D / 2 + 0.035, 0.414, hmax=0.27)
    m.box((0.34, 0.27, 0.25), (-inner / 2 + 0.185, -0.015, 0.084 + 0.125), 'cream', bevel=0.02, seg=3)
    m.box((0.09, 0.012, 0.03), (-inner / 2 + 0.185, -0.155, 0.26), 'woodDark', bevel=0.005, outline=False)
    m.box((0.3, 0.27, 0.25), (inner / 2 - 0.165, -0.015, 0.084 + 0.125), 'fabric', bevel=0.02, seg=3)
    m.box((0.09, 0.012, 0.03), (inner / 2 - 0.165, -0.155, 0.26), 'woodDark', bevel=0.005, outline=False)
    return m


def rack():
    """衣帽架:圓底座、木桿、四支掛勾,掛著一頂帽子和一個側背包。"""
    m = Model('rack')
    m.cyl(0.19, 0.17, 0.035, (0, 0, 0.0175), 'woodDark', segs=28, bevel=0.01)
    m.cyl(0.022, 0.02, 1.7, (0, 0, 0.87), 'wood', segs=12)
    m.ball(0.035, (0, 0, 1.73), 'wood')
    for i in range(4):
        a = i * math.pi / 2 + 0.6
        m.cyl(0.012, 0.012, 0.2, (math.cos(a) * 0.08, math.sin(a) * 0.08, 1.56), 'wood', segs=8,
              rot=(-math.sin(a) * 1.0, math.cos(a) * 1.0, 0))
    a = 0.6 + math.pi * 1.5
    hx, hy = math.cos(a) * 0.17, math.sin(a) * 0.17
    m.cyl(0.15, 0.15, 0.012, (hx, hy, 1.63), 'fabric', segs=24, rot=(0.5, 0.2, 0))        # 帽子
    m.cyl(0.085, 0.075, 0.09, (hx + 0.01, hy - 0.02, 1.67), 'fabric', segs=24, rot=(0.5, 0.2, 0), bevel=0.02)
    a = 0.6
    bx, by = math.cos(a) * 0.2, math.sin(a) * 0.2
    m.box((0.012, 0.012, 0.42), (bx, by, 1.42), 'woodDark', bevel=0.004, outline=False)   # 包包背帶
    m.box((0.26, 0.09, 0.2), (bx, by, 1.14), 'fabric2', bevel=0.035, seg=3, rot=(0, 0, a + math.pi / 2))
    return m


def box():
    """紙箱:半開的箱蓋、一條封箱膠帶。"""
    m = Model('box')
    m.box((0.5, 0.4, 0.34), (0, 0, 0.17), 'cardboard', bevel=0.008)
    m.box((0.07, 0.402, 0.342), (0, 0, 0.17), 'cream', bevel=0.004, outline=False)
    for sx in (-1, 1):
        m.box((0.25, 0.39, 0.012), (sx * 0.34, 0, 0.385), 'cardboard', bevel=0.004, rot=(0, -sx * 0.5, 0))
    m.box((0.2, 0.26, 0.05), (0.05, 0, 0.33), 'bookC', bevel=0.006, seg=1, rot=(0, 0, 0.2))
    return m


# ---------------- 床與沙發 ----------------

def bed(name, w):
    """床,長 1.95:木床架與床頭板、床墊、蓋到一半的被子、枕頭。床頭在 +Y(靠牆)。"""
    m = Model(name)
    L = 1.95
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.box((0.07, 0.07, 0.2), (sx * (w / 2 - 0.06), sy * (L / 2 - 0.06), 0.1), 'woodDark', bevel=0.014, outline=False)
    m.box((w, L, 0.14), (0, 0, 0.25), 'wood', bevel=0.02)
    m.box((w, 0.06, 0.95), (0, L / 2 - 0.03, 0.475), 'wood', bevel=0.03, seg=3)             # 床頭板
    m.box((w - 0.06, L - 0.12, 0.2), (0, -0.03, 0.41), 'white', bevel=0.06, seg=4)          # 床墊
    m.box((w + 0.02, L * 0.6, 0.11), (0, -L * 0.2 + 0.02, 0.5), 'fabric', bevel=0.05, seg=4)  # 被子
    m.box((w + 0.022, 0.14, 0.112), (0, L * 0.1 + 0.03, 0.5), 'white', bevel=0.05, seg=4, outline=False)  # 反摺的被頭
    n = 1 if w < 1.2 else 2
    for i in range(n):
        x = 0 if n == 1 else (i - 0.5) * (w / 2)
        m.box((min(0.62, w / n - 0.16), 0.36, 0.12), (x, L / 2 - 0.3, 0.55), 'cream', bevel=0.055, seg=4, rot=(0.12, 0, 0))
    return m


def sofa(name, w, pillows=True):
    """沙發:布面坐墊與靠背、圓扶手、短木腳、抱枕。座面高 0.42,正面朝 -Y。"""
    m = Model(name)
    D = 0.86
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.cyl(0.028, 0.02, 0.1, (sx * (w / 2 - 0.12), sy * (D / 2 - 0.12), 0.05), 'woodDark', segs=10, outline=False)
    m.box((w, D, 0.2), (0, 0, 0.2), 'fabric', bevel=0.06, seg=4)                             # 底座
    m.box((w - 0.12, 0.22, 0.52), (0, D / 2 - 0.13, 0.52), 'fabric', bevel=0.09, seg=4, rot=(-0.1, 0, 0))  # 靠背
    seats = max(1, round((w - 0.3) / 0.75))
    sw = (w - 0.34) / seats
    for i in range(seats):
        x = -(w - 0.34) / 2 + sw * (i + 0.5)
        m.box((sw - 0.012, D - 0.3, 0.15), (x, -0.07, 0.345), 'fabric', bevel=0.055, seg=4)  # 坐墊
        m.box((sw - 0.03, 0.16, 0.36), (x, D / 2 - 0.25, 0.6), 'fabric', bevel=0.07, seg=4, rot=(-0.16, 0, 0))  # 背墊
    for sx in (-1, 1):
        m.box((0.2, D - 0.04, 0.46), (sx * (w / 2 - 0.1), -0.01, 0.37), 'fabric', bevel=0.085, seg=4)  # 扶手
    if pillows:
        m.box((0.34, 0.12, 0.32), (-(w / 2 - 0.36), 0.03, 0.56), 'cream', bevel=0.055, seg=4, rot=(-0.3, 0, 0.25))
        if seats > 1:
            m.box((0.3, 0.11, 0.28), (w / 2 - 0.37, 0.04, 0.55), 'fabric2', bevel=0.05, seg=4, rot=(-0.3, 0, -0.3))
    return m


def ottoman():
    """腳凳 0.6 見方,高 0.4。"""
    m = Model('ottoman')
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.cyl(0.026, 0.02, 0.1, (sx * 0.2, sy * 0.2, 0.05), 'woodDark', segs=10, outline=False)
    m.box((0.6, 0.6, 0.3), (0, 0, 0.25), 'fabric', bevel=0.09, seg=4)
    m.cyl(0.03, 0.03, 0.012, (0, 0, 0.402), 'cream', segs=14, outline=False)
    return m


# ---------------- 電器 ----------------

def tv():
    """電視櫃 1.7 × 0.4 高 0.45 + 液晶電視。畫面由遊戲端貼圖。"""
    m = Model('tv')
    W, D, H, z0 = 1.7, 0.4, 0.45, 0.1
    for sx in (-0.75, 0.75):
        for sy in (-0.14, 0.14):
            m.cyl(0.022, 0.016, z0, (sx, sy, z0 / 2), 'woodDark', segs=10, outline=False)
    m.box((W, D, H - z0), (0, 0, z0 + (H - z0) / 2), 'wood', bevel=0.02)
    yf = -D / 2 + 0.006
    for sx in (-1, 1):
        m.box((0.5, 0.02, H - z0 - 0.07), (sx * 0.56, yf, z0 + (H - z0) / 2), 'white', bevel=0.01)
        m.box((0.1, 0.018, 0.014), (sx * 0.56, yf - 0.014, z0 + (H - z0) / 2 + 0.07), 'woodDark', bevel=0.005, outline=False)
    m.box((0.54, 0.3, H - z0 - 0.07), (0, yf + 0.13, z0 + (H - z0) / 2), 'woodDark', bevel=0.004, outline=False)
    m.box((0.3, 0.2, 0.05), (0, yf + 0.12, z0 + 0.065), 'dark', bevel=0.008)                 # 遊戲主機
    sw, sh, sz = 1.2, 0.7, H + 0.44
    m.box((0.5, 0.2, 0.014), (0, 0.02, H + 0.007), 'bezel', bevel=0.005)
    m.box((0.08, 0.03, 0.12), (0, 0.04, H + 0.06), 'bezel', bevel=0.01)
    m.box((sw, 0.035, sh), (0, 0.02, sz), 'bezel', bevel=0.014, seg=3)
    m.quad(sw - 0.05, sh - 0.05, (0, 0.02 - 0.0185, sz), 'screen')
    potted(m, 0.68, 0.0, H, r=0.055, h=0.08, leaves=7)
    return m


def fridge():
    """冰箱 0.66 × 0.66,高 1.7:上下兩門、把手、幾個磁鐵。"""
    m = Model('fridge')
    m.box((0.66, 0.62, 1.7), (0, 0.02, 0.85), 'white', bevel=0.035, seg=3)
    m.box((0.64, 0.03, 0.56), (0, -0.3, 1.39), 'white', bevel=0.03, seg=3)
    m.box((0.64, 0.03, 1.04), (0, -0.3, 0.57), 'white', bevel=0.03, seg=3)
    for z, hh in ((1.3, 0.24), (0.84, 0.34)):
        m.box((0.03, 0.03, hh), (-0.25, -0.33, z), 'metal', bevel=0.012)
    for dx, dz, c in ((0.12, 1.5, 'bookA'), (0.2, 1.42, 'bookB'), (0.05, 1.36, 'bookD')):
        m.box((0.05, 0.008, 0.05), (dx, -0.318, dz), c, bevel=0.012, outline=False)
    m.box((0.14, 0.004, 0.18), (0.14, -0.317, 0.9), 'cream', bevel=0.0, rot=(0, 0.08, 0), outline=False)   # 貼著的便條
    return m


def speaker():
    """落地喇叭 0.28 × 0.3,高 0.95。"""
    m = Model('speaker')
    m.box((0.28, 0.3, 0.93), (0, 0, 0.485), 'woodDark', bevel=0.02)
    m.box((0.24, 0.012, 0.86), (0, -0.152, 0.49), 'dark', bevel=0.012, outline=False)
    for z, r in ((0.74, 0.05), (0.52, 0.085), (0.28, 0.095)):
        m.cyl(r, r, 0.012, (0, -0.16, z), 'metal', segs=24, rot=X90, outline=False)
        m.cyl(r * 0.45, r * 0.45, 0.016, (0, -0.162, z), 'dark', segs=16, rot=X90, outline=False)
    for sx in (-1, 1):
        m.cyl(0.02, 0.02, 0.02, (sx * 0.1, 0, 0.01), 'dark', segs=8, outline=False)
    return m


def arcade():
    """大型電玩機台:傾斜的螢幕、發光的招牌、搖桿和按鈕。畫面由遊戲端貼圖。"""
    m = Model('arcade')
    m.box((0.62, 0.66, 0.9), (0, 0.02, 0.45), 'fabric', bevel=0.02)
    m.box((0.62, 0.5, 0.82), (0, 0.1, 1.27), 'fabric', bevel=0.02)
    m.box((0.66, 0.3, 0.16), (0, 0.0, 1.66), 'fabric', bevel=0.02)                            # 招牌罩
    m.box((0.56, 0.012, 0.11), (0, -0.152, 1.66), 'shade', bevel=0.004, outline=False)
    m.box((0.56, 0.02, 0.5), (0, -0.17, 1.27), 'bezel', bevel=0.01, rot=(-0.2, 0, 0))         # 螢幕框
    m.quad(0.5, 0.42, (0, -0.184, 1.272), 'screen', rot=(-0.2, 0, 0))
    m.box((0.62, 0.3, 0.05), (0, -0.33, 0.93), 'dark', bevel=0.014, rot=(0.2, 0, 0))          # 控制台
    m.cyl(0.012, 0.012, 0.09, (-0.16, -0.36, 1.0), 'metal', segs=8, outline=False)
    m.ball(0.032, (-0.16, -0.36, 1.06), 'red')
    for k, c in enumerate(('bookB', 'bookD', 'bookC')):
        m.cyl(0.028, 0.028, 0.016, (0.04 + k * 0.085, -0.37 + (k % 2) * 0.03, 0.972), c, segs=14, rot=(0.2, 0, 0), outline=False)
    m.box((0.4, 0.012, 0.3), (0, -0.315, 0.5), 'dark', bevel=0.012, outline=False)            # 投幣口面板
    for sx in (-1, 1):
        m.box((0.03, 0.006, 0.06), (sx * 0.08, -0.324, 0.52), 'brass', bevel=0.004, outline=False)
    return m


def vending():
    """販賣機 0.8 × 0.7,高 1.8:櫥窗裡一排排飲料罐、按鈕面板、取物口、頂部燈條。"""
    m = Model('vending')
    m.box((0.8, 0.66, 1.8), (0, 0.02, 0.9), 'fabric', bevel=0.03, seg=3)
    yf = -0.31
    m.box((0.5, 0.02, 1.02), (-0.11, yf, 1.12), 'bezel', bevel=0.012)                          # 櫥窗
    m.box((0.46, 0.012, 0.98), (-0.11, yf - 0.006, 1.12), 'cream', bevel=0.006, outline=False)
    cans = ['bookA', 'bookB', 'bookC', 'bookD', 'bookE', 'red']
    for r in range(4):
        z = 0.72 + r * 0.235
        m.box((0.46, 0.03, 0.014), (-0.11, yf - 0.02, z - 0.012), 'metal', bevel=0.003, outline=False)
        for c in range(5):
            m.cyl(0.034, 0.034, 0.13, (-0.11 - 0.184 + c * 0.092, yf - 0.03, z + 0.06), cans[(r * 2 + c) % 6], segs=12, outline=False)
    m.box((0.2, 0.02, 0.62), (0.27, yf, 1.32), 'dark', bevel=0.012)                            # 按鈕面板
    for r in range(4):
        m.box((0.13, 0.012, 0.045), (0.27, yf - 0.014, 1.52 - r * 0.09), 'shade' if r == 0 else 'white', bevel=0.008, outline=False)
    m.box((0.05, 0.012, 0.09), (0.27, yf - 0.014, 1.12), 'brass', bevel=0.006, outline=False)  # 投幣口
    m.box((0.5, 0.03, 0.2), (-0.11, yf, 0.36), 'dark', bevel=0.012)                            # 取物口
    m.box((0.72, 0.012, 0.1), (0, yf - 0.003, 1.72), 'shade', bevel=0.006, outline=False)
    return m


# ---------------- 植物與燈飾 ----------------

def floorlamp():
    """立燈,高 1.76:圓底座、細桿、布燈罩。"""
    m = Model('floorlamp')
    m.cyl(0.16, 0.14, 0.03, (0, 0, 0.015), 'woodDark', segs=28, bevel=0.009)
    m.cyl(0.014, 0.014, 1.46, (0, 0, 0.76), 'metal', segs=12)
    m.cyl(0.21, 0.14, 0.28, (0, 0, 1.62), 'shade', segs=32, bevel=0.008)
    m.cyl(0.212, 0.212, 0.014, (0, 0, 1.487), 'cream', segs=32, outline=False)
    return m


def plant_big():
    """大盆栽,高約 1.45:陶盆、細樹幹、往外展開的大葉片。"""
    m = Model('plant_big')
    rnd = random.Random(4)
    m.cyl(0.15, 0.19, 0.32, (0, 0, 0.16), 'pot', segs=24, bevel=0.02)
    m.cyl(0.175, 0.175, 0.012, (0, 0, 0.312), 'soil', segs=24, outline=False)
    m.cyl(0.022, 0.03, 0.75, (0, 0, 0.68), 'woodDark', segs=10, rot=(0.04, -0.03, 0))
    for i in range(11):
        a = i * 2.4
        h = 0.72 + (i / 10) * 0.6
        out = 0.12 + 0.2 * math.sin(i / 10 * math.pi)
        tilt = 0.5 + 0.5 * (1 - i / 10)
        m.ball(0.12, (math.cos(a) * out, math.sin(a) * out, h), 'plant', scale=(0.62, 0.16, 1.45 + rnd.uniform(-0.15, 0.2)),
               rot=(-math.sin(a) * tilt, math.cos(a) * tilt, a + math.pi / 2))
    return m


def plant():
    """中型盆栽,高約 0.8:白色圓盆 + 三圈往外展開的長葉片。"""
    m = Model('plant')
    m.cyl(0.13, 0.16, 0.26, (0, 0, 0.13), 'white', segs=24, bevel=0.03)
    m.cyl(0.145, 0.145, 0.012, (0, 0, 0.255), 'soil', segs=24, outline=False)
    rnd = random.Random(8)
    for ring, (n, out, tilt, length, z) in enumerate(((7, 0.13, 0.95, 1.9, 0.36), (6, 0.085, 0.6, 2.2, 0.45), (4, 0.035, 0.25, 2.4, 0.52))):
        for i in range(n):
            a = i * 2 * math.pi / n + ring * 0.5 + rnd.uniform(-0.12, 0.12)
            m.ball(0.085, (math.cos(a) * out, math.sin(a) * out, z + rnd.uniform(-0.02, 0.02)), 'plant',
                   scale=(0.55, 0.16, length + rnd.uniform(-0.2, 0.2)), rot=(-math.sin(a) * tilt, math.cos(a) * tilt, a + math.pi / 2))
    return m


def pendant():
    """天花板吊燈:原點在天花板上的吊點,往下垂。燈罩的亮度由遊戲端依時段調整。"""
    m = Model('pendant')
    m.cyl(0.06, 0.06, 0.02, (0, 0, -0.01), 'white', segs=20, bevel=0.005)
    m.cyl(0.006, 0.006, 0.42, (0, 0, -0.22), 'dark', segs=8, outline=False)
    m.cyl(0.05, 0.03, 0.05, (0, 0, -0.45), 'brass', segs=16, bevel=0.008)
    m.cyl(0.3, 0.09, 0.22, (0, 0, -0.58), 'shade', segs=36, bevel=0.01)
    m.cyl(0.302, 0.302, 0.014, (0, 0, -0.695), 'cream', segs=36, outline=False)
    return m


def bin_():
    """垃圾桶:金屬圓桶,裡面幾團紙。"""
    m = Model('bin')
    m.cyl(0.13, 0.16, 0.34, (0, 0, 0.17), 'metal', segs=24, bevel=0.012)
    m.cyl(0.165, 0.165, 0.02, (0, 0, 0.335), 'dark', segs=24, bevel=0.006, outline=False)
    for dx, dy, r in ((0.03, 0.02, 0.06), (-0.05, -0.03, 0.05), (0.0, -0.06, 0.045)):
        m.ball(r, (dx, dy, 0.34), 'white', scale=(1, 1, 0.8), outline=False)
    return m


def cat():
    """趴坐的貓:奶油色身體、深色耳朵與尾巴。臉朝 -Y。"""
    m = Model('cat')
    m.ball(0.16, (0, 0.03, 0.125), 'cream', scale=(0.95, 1.35, 0.78))                          # 身體
    m.ball(0.105, (0, -0.2, 0.2), 'cream', scale=(1.08, 0.95, 0.92))                           # 頭
    for sx in (-1, 1):
        m.cyl(0.042, 0.004, 0.075, (sx * 0.062, -0.19, 0.305), 'woodDark', segs=10, rot=(0, sx * 0.25, 0))  # 耳朵
        m.ball(0.014, (sx * 0.042, -0.292, 0.212), 'dark', scale=(1, 0.5, 1.25), outline=False)  # 眼睛
        m.ball(0.035, (sx * 0.07, -0.19, 0.03), 'cream', scale=(1, 1.5, 0.8))                  # 前腳
    m.ball(0.011, (0, -0.302, 0.183), 'pink', scale=(1.3, 0.6, 0.9), outline=False)            # 鼻子
    for k in range(7):                                                                       # 捲起來的尾巴
        a = 0.3 + k * 0.38
        m.ball(0.036 - k * 0.002, (0.13 + math.sin(a) * 0.07, 0.18 - math.cos(a) * 0.09 + 0.05, 0.045), 'woodDark',
               outline=(k % 2 == 0))
    m.ball(0.06, (0.02, 0.06, 0.2), 'woodDark', scale=(1.2, 1.4, 0.35), outline=False)         # 背上的花斑
    return m


def cat_walk():
    """站著走路的貓(和趴坐的貓同一隻):四隻腳、翹起來的尾巴。臉朝 -Y。"""
    m = Model('cat_walk')
    m.ball(0.13, (0, 0.04, 0.24), 'cream', scale=(0.9, 1.75, 0.85))                           # 身體
    m.ball(0.105, (0, -0.24, 0.33), 'cream', scale=(1.08, 0.95, 0.92))                         # 頭
    for sx in (-1, 1):
        m.cyl(0.042, 0.004, 0.075, (sx * 0.062, -0.23, 0.435), 'woodDark', segs=10, rot=(0, sx * 0.25, 0))
        m.ball(0.014, (sx * 0.042, -0.332, 0.342), 'dark', scale=(1, 0.5, 1.25), outline=False)
        for sy in (-0.1, 0.19):                                                              # 四隻腳
            m.cyl(0.03, 0.034, 0.17, (sx * 0.07, sy, 0.085), 'cream', segs=10, bevel=0.012)
    m.ball(0.011, (0, -0.342, 0.313), 'pink', scale=(1.3, 0.6, 0.9), outline=False)
    for k in range(7):                                                                       # 往上翹的尾巴
        m.ball(0.034 - k * 0.002, (0, 0.26 + k * 0.012 - k * k * 0.004, 0.27 + k * 0.045), 'woodDark', outline=(k % 2 == 0))
    m.ball(0.06, (0.02, 0.08, 0.335), 'woodDark', scale=(1.2, 1.5, 0.35), outline=False)       # 背上的花斑
    return m


# ---------------- 角色配件(掛在頭部骨架上;原點 = 頭部骨架的位置,臉朝 -Y) ----------------
# 耳機和眼鏡以臉的位置為準;貓耳和帽子的原點在「頭頂」,遊戲端會依每個角色的頭髮高度往上移。

def acc_headphones():
    m = Model('acc_headphones')
    R, zc, y0 = 0.108, 0.075, 0.012
    n = 13
    for i in range(n):                                                    # 頭帶:沿著圓弧排一圈小方塊
        a = math.pi * (0.06 + 0.88 * i / (n - 1))
        m.box((0.032, 0.03, 0.012), (R * math.cos(a), y0, zc + R * math.sin(a)), 'dark', bevel=0.005, rot=(0, math.pi / 2 - a, 0), outline=(i % 2 == 0))
    for sx in (-1, 1):
        m.box((0.012, 0.02, 0.05), (sx * R, y0, zc + 0.03), 'metal', bevel=0.004, outline=False)                 # 伸縮桿
        m.cyl(0.05, 0.05, 0.03, (sx * (R - 0.004), y0, zc - 0.005), 'fabric', segs=20, rot=Y90, bevel=0.01)    # 耳罩外殼
        m.cyl(0.042, 0.046, 0.016, (sx * (R - 0.022), y0, zc - 0.005), 'cream', segs=20, rot=Y90, bevel=0.006, outline=False)  # 耳墊
        m.cyl(0.02, 0.02, 0.004, (sx * (R + 0.012), y0, zc - 0.005), 'white', segs=14, rot=Y90, outline=False)
    return m


def acc_glasses():
    m = Model('acc_glasses')
    yf, z, ex, r = -0.098, 0.062, 0.034, 0.027
    for sx in (-1, 1):
        for i in range(14):                                               # 圓框
            a = i * 2 * math.pi / 14
            m.box((0.014, 0.006, 0.006), (sx * ex + math.cos(a) * r, yf, z + math.sin(a) * r), 'dark', bevel=0.002, seg=1,
                  rot=(0, -(a + math.pi / 2), 0), outline=False)
        m.box((0.006, 0.105, 0.006), (sx * (ex + r + 0.012), yf + 0.05, z + 0.006), 'dark', bevel=0.002, seg=1, rot=(0, 0, sx * 0.13), outline=False)  # 鏡腳
    m.box((0.02, 0.006, 0.006), (0, yf, z + 0.008), 'dark', bevel=0.002, seg=1, outline=False)          # 鼻樑
    return m


def acc_catears():
    m = Model('acc_catears')
    for sx in (-1, 1):
        m.cyl(0.036, 0.004, 0.085, (sx * 0.062, 0.0, 0.012), 'fabric', segs=12, rot=(0, sx * 0.3, 0))
        m.cyl(0.02, 0.002, 0.05, (sx * 0.06, -0.014, 0.008), 'pink', segs=10, rot=(0, sx * 0.3, 0), outline=False)
    return m


def acc_beret():
    m = Model('acc_beret')
    m.ball(0.118, (0.012, 0.01, -0.012), 'fabric', scale=(1.12, 1.12, 0.36), rot=(0.1, -0.16, 0))
    m.cyl(0.085, 0.09, 0.016, (0.0, 0.0, -0.04), 'fabric', segs=24, rot=(0.06, -0.08, 0), outline=False)   # 帽圍
    m.cyl(0.006, 0.006, 0.022, (0.02, 0.012, 0.034), 'fabric', segs=8, rot=(0.1, -0.16, 0), outline=False)  # 頂上的小蒂
    return m


def acc_bow():
    """蝴蝶結:兩片往外翹的扁蝶翼、中間的結、兩條垂下來的緞帶。原點在頭頂。"""
    m = Model('acc_bow')
    for sx in (-1, 1):
        m.box((0.078, 0.02, 0.07), (sx * 0.05, 0.0, 0.036), 'fabric', bevel=0.014, seg=3, rot=(0, -sx * 0.3, 0))    # 扁平的蝶翼,往外往上翹
        m.box((0.03, 0.022, 0.03), (sx * 0.018, -0.001, 0.03), 'fabric', bevel=0.008, outline=False)                 # 靠近結的地方收窄
        m.box((0.02, 0.012, 0.075), (sx * 0.022, 0.014, -0.02), 'fabric', bevel=0.004, rot=(0, sx * 0.4, 0), outline=False)
    m.ball(0.02, (0, -0.004, 0.028), 'fabric', scale=(0.9, 1.0, 1.1))
    return m


def acc_crown():
    """小皇冠:金色的環、五個尖角、尖端各一顆珠子,戴在頭頂偏一邊。"""
    m = Model('acc_crown')
    m.cyl(0.05, 0.055, 0.03, (0, 0, 0.015), 'brass', segs=20, bevel=0.004)
    for i in range(5):
        a = i * 2 * math.pi / 5 + math.pi / 2
        x, y = math.cos(a) * 0.045, math.sin(a) * 0.045
        m.cyl(0.018, 0.002, 0.045, (x, y, 0.05), 'brass', segs=8)
        m.ball(0.008, (x, y, 0.075), 'pink', outline=False)
    return m


def acc_flower():
    """別在頭側的花:五片花瓣加花蕊。"""
    m = Model('acc_flower')
    cx, cy, cz = 0.085, -0.05, -0.03
    for i in range(5):
        a = i * 2 * math.pi / 5 + 0.3
        m.ball(0.024, (cx + math.cos(a) * 0.026, cy, cz + math.sin(a) * 0.026), 'fabric', scale=(1, 0.45, 1), outline=(i % 2 == 0))
    m.ball(0.014, (cx, cy - 0.008, cz), 'brass', scale=(1, 0.6, 1), outline=False)
    return m


# ---------------- 桌上小物 ----------------

def laptop():
    """筆電:打開的螢幕(畫面由遊戲端貼圖)、鍵盤區、觸控板。"""
    m = Model('laptop')
    m.box((0.36, 0.25, 0.016), (0, -0.02, 0.008), 'kbd', bevel=0.006)
    m.box((0.31, 0.12, 0.003), (0, 0.01, 0.017), 'dark', bevel=0.0, outline=False)
    m.box((0.11, 0.07, 0.003), (0, -0.1, 0.017), 'white', bevel=0.0, outline=False)
    t = -0.22
    m.box((0.36, 0.012, 0.24), (0, 0.105 + 0.026, 0.13), 'kbd', bevel=0.006, rot=(t, 0, 0))
    m.quad(0.33, 0.21, (0, 0.105 + 0.019, 0.129), 'screen', rot=(t, 0, 0))
    return m


def books():
    """書堆:四本橫放、兩本直立靠著,再加一個筆筒。"""
    m = Model('books')
    rnd = random.Random(2)
    z = 0.0
    for k in range(4):
        t = rnd.uniform(0.03, 0.045)
        m.box((0.2 - k * 0.012, 0.27 - k * 0.015, t), (-0.08, 0.0, z + t / 2), BOOKS[(k * 2 + 1) % 6], bevel=0.005, seg=1,
              rot=(0, 0, rnd.uniform(-0.2, 0.2)))
        z += t + 0.001
    m.cyl(0.04, 0.036, 0.1, (0.17, -0.06, 0.05), 'fabric', segs=16, bevel=0.006)
    for dx, dy, c, tl in ((0.0, 0.0, 'bookB', 0.12), (0.014, 0.01, 'bookA', -0.1), (-0.012, 0.012, 'bookD', 0.05)):
        m.cyl(0.006, 0.006, 0.15, (0.17 + dx, -0.06 + dy, 0.11), c, segs=6, rot=(tl, tl * 0.6, 0), outline=False)
    return m


def plant_small():
    m = Model('plant_small')
    potted(m, 0, 0, 0, r=0.07, h=0.1, leaves=8, leaf=0.06)
    return m


def succulent():
    """多肉:寬淺的白盆 + 一圈圈肥厚的葉片。"""
    m = Model('succulent')
    m.cyl(0.075, 0.09, 0.07, (0, 0, 0.035), 'white', segs=20, bevel=0.012)
    for ring, (n, r, h, s) in enumerate(((8, 0.06, 0.085, 0.036), (6, 0.035, 0.105, 0.03), (1, 0.0, 0.12, 0.026))):
        for i in range(n):
            a = i * 2 * math.pi / n + ring * 0.4
            m.ball(s, (math.cos(a) * r, math.sin(a) * r, h), 'plant', scale=(0.9, 0.9, 1.3),
                   rot=(-math.sin(a) * 0.7, math.cos(a) * 0.7, 0), outline=(ring == 0))
    return m


def radio():
    """復古收音機:圓角機身、喇叭網、兩顆旋鈕、提把和天線。"""
    m = Model('radio')
    m.box((0.32, 0.12, 0.18), (0, 0, 0.1), 'fabric', bevel=0.03, seg=3)
    for sx in (-1, 1):
        m.cyl(0.012, 0.012, 0.02, (sx * 0.12, 0, 0.01), 'dark', segs=8, outline=False)
    m.cyl(0.062, 0.062, 0.01, (-0.07, -0.062, 0.1), 'cream', segs=24, rot=X90, outline=False)
    m.cyl(0.045, 0.045, 0.014, (-0.07, -0.063, 0.1), 'woodDark', segs=20, rot=X90, outline=False)
    m.box((0.1, 0.01, 0.04), (0.08, -0.062, 0.13), 'cream', bevel=0.006, outline=False)
    for dx in (0.055, 0.105):
        m.cyl(0.016, 0.016, 0.02, (dx, -0.066, 0.075), 'brass', segs=12, rot=X90, outline=False)
    m.box((0.2, 0.014, 0.014), (0, 0, 0.215), 'dark', bevel=0.005)
    for sx in (-1, 1):
        m.box((0.014, 0.014, 0.04), (sx * 0.1, 0, 0.2), 'dark', bevel=0.004, outline=False)
    m.cyl(0.004, 0.004, 0.26, (0.13, 0.03, 0.3), 'metal', segs=6, rot=(0, 0.35, 0), outline=False)
    return m


def teaset():
    """茶具:木托盤、圓茶壺、兩個杯子。"""
    m = Model('teaset')
    m.box((0.36, 0.24, 0.016), (0, 0, 0.008), 'wood', bevel=0.007)
    m.ball(0.065, (-0.07, 0.01, 0.075), 'white', scale=(1, 1, 0.9))
    m.cyl(0.03, 0.03, 0.01, (-0.07, 0.01, 0.133), 'white', segs=14, outline=False)
    m.ball(0.013, (-0.07, 0.01, 0.146), 'brass', outline=False)
    m.cyl(0.012, 0.017, 0.07, (-0.14, 0.01, 0.09), 'white', segs=8, rot=(0, -0.9, 0))        # 壺嘴
    m.box((0.014, 0.02, 0.07), (0.005, 0.01, 0.08), 'white', bevel=0.006)                    # 把手
    for dx, dy in ((0.1, -0.05), (0.11, 0.06)):
        m.cyl(0.03, 0.024, 0.045, (dx, dy, 0.0385), 'white', segs=14, bevel=0.005)
        m.cyl(0.024, 0.024, 0.003, (dx, dy, 0.059), 'woodDark', segs=14, outline=False)
    return m


ALL = {
    'desk': desk, 'chair': chair, 'bookcase': bookcase, 'lamp': lamp, 'monitor': monitor,
    'window': window, 'door': door, 'frame': frame, 'poster': poster, 'clock': clock, 'wallshelf': wallshelf,
    'walllamp': walllamp, 'mirror': mirror,
    'dchair': dchair, 'stool': stool, 'table': table, 'coffee': coffee, 'side': side,
    'cabinet': cabinet, 'sideboard': sideboard, 'lowcase': lowcase, 'rack': rack, 'box': box,
    'bed': lambda: bed('bed', 0.95), 'bed_double': lambda: bed('bed_double', 1.85),
    'sofa': lambda: sofa('sofa', 1.85), 'armchair': lambda: sofa('armchair', 0.92, pillows=False), 'ottoman': ottoman,
    'tv': tv, 'fridge': fridge, 'speaker': speaker, 'arcade': arcade, 'vending': vending,
    'floorlamp': floorlamp, 'plant_big': plant_big, 'plant': plant, 'bin': bin_, 'cat': cat, 'cat_walk': cat_walk, 'pendant': pendant,
    'acc_headphones': acc_headphones, 'acc_glasses': acc_glasses, 'acc_catears': acc_catears, 'acc_beret': acc_beret, 'acc_bow': acc_bow, 'acc_crown': acc_crown, 'acc_flower': acc_flower,
    'laptop': laptop, 'books': books, 'plant_small': plant_small, 'succulent': succulent, 'radio': radio, 'teaset': teaset,
}

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    out = args[0] if args else os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'assets', 'studio')
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name in (args[1:] or ALL):
        ALL[name]().export(out)
