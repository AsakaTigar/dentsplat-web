async () => {
  const D = window.DentSplat;
  const v = D.viewer;
  const gl = v.renderer.getContext();
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const st = {
    scissorTest: !!gl.getParameter(gl.SCISSOR_TEST),
    scissorBox: gl.getParameter(gl.SCISSOR_BOX),
    viewport: gl.getParameter(gl.VIEWPORT),
    canvas: [v.canvas ? v.canvas.width : -1, v.canvas ? v.canvas.height : -1],
    camera: {
      aspect: r3(v.camera.aspect), fov: v.camera.fov, near: v.camera.near, far: v.camera.far,
      pos: v.camera.position.toArray().map(r3),
    },
    layerVisible: !!(v.layer && v.layer.mesh.visible),
    splitCompare: !!v.splitCompare,
  };
  const pick = (o) => ({
    box: o.box && { lit: o.box.lit, calls: o.box.calls, mid: o.box.mid },
    splat: o.splat && { lit: o.splat.lit, calls: o.splat.calls, mid: o.splat.mid },
  });
  const before = pick(D.selfTest());
  v.renderer.setScissorTest(false);
  const prevAspect = v.camera.aspect;
  v.camera.aspect = 1;
  v.camera.updateProjectionMatrix();
  const after = pick(D.selfTest());
  v.camera.aspect = prevAspect;
  v.camera.updateProjectionMatrix();
  return { st, before, after };
}
