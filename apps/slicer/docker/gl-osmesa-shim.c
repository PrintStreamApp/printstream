/*
 * gl-osmesa-shim: LD_PRELOAD shim that lets the BambuStudio CLI's offscreen thumbnail
 * renderer initialise in a headless runtime. Compiled for x86-64 (the only arch the CLI
 * ships) by apps/slicer/Dockerfile and the dev setup scripts; loaded into the CLI process
 * by bambu-studio-cli.sh (its counterpart, which also provides the Wayland display the
 * CLI's GLFW needs). Not compiled into, or linked by, any PrintStream code.
 *
 * Why the CLI cannot render thumbnails on its own (BambuStudio 2.x, Linux):
 *  - Its bundled GLFW 3.3.7 is built Wayland-only (deps/GLFW: GLFW_USE_WAYLAND=ON, a
 *    compile-time choice in 3.3.x), so glfwInit() needs a Wayland compositor — Xvfb can
 *    never satisfy it. bambu-studio-cli.sh provides a headless Weston for this.
 *  - The CLI then forces an OSMesa (pure software) GL context: BambuStudio.cpp hints
 *    GLFW_CONTEXT_CREATION_API = GLFW_OSMESA_CONTEXT_API on __linux__, and GLFW dlopens
 *    libOSMesa.so.8 for it (the sysroot/image installs libosmesa6).
 *  - Its statically linked GLEW is a plain GLX build, so glewInit() -> glxewInit()
 *    demands a *current GLX context* (glXGetCurrentDisplay() != NULL). An OSMesa context
 *    never provides one, so GL init fails with "Unable to init glew library" and the CLI
 *    logs "init opengl failed! skip thumbnail generating". That combination — GLX-built
 *    GLEW + forced OSMesa context — can never work unshimmed; it is why thumbnails have
 *    never rendered headless, not a missing package.
 *  - Separately, with a glvnd libGL (any modern distro) the binary's direct GL 1.1 calls
 *    would dispatch through glvnd's notion of the current context (none — glvnd only
 *    learns of contexts via glXMakeCurrent), not through the OSMesa context.
 *
 * What the shim does (contract):
 *  - Exports every GL 1.1 symbol the binary imports directly (the full list below was
 *    enumerated from `readelf --dyn-syms bin/bambu-studio`), forwarding each to the real
 *    OSMesa entry point via OSMesaGetProcAddress — pointers that dispatch to the OSMesa
 *    context regardless of glvnd.
 *  - Interposes glXGetProcAddress(ARB), GLEW's resolver, so every GLEW function pointer
 *    also comes from OSMesa; glX* names resolve through dlsym, finding the fakes below
 *    first and libGL's real exports otherwise.
 *  - Fakes the few GLX entry points glxewInit actually calls: a non-NULL "current
 *    display", GLX version 1.4, empty extension strings. Nothing real backs them — the
 *    render path never touches GLX again once glewInit has passed.
 *
 * Failure semantics: if libOSMesa cannot be loaded, every forwarder degrades to a no-op
 * (NULL/0 returns) — the CLI then fails GL init and skips thumbnails exactly as it does
 * without the shim; a slice never fails because of this shim. The shim must never be
 * preloaded into anything but the BambuStudio CLI.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>

typedef unsigned int GLenum;
typedef unsigned int GLuint;
typedef unsigned int GLbitfield;
typedef int GLint;
typedef int GLsizei;
typedef unsigned char GLboolean;
typedef unsigned char GLubyte;
typedef unsigned short GLushort;
typedef float GLfloat;
typedef double GLdouble;

static void *(*osmesa_get_proc)(const char *);

static void *osmesa_proc(const char *name)
{
    if (!osmesa_get_proc) {
        /* GLFW has usually dlopened libOSMesa already (refcounted, so this is cheap);
         * resolving through OSMesaGetProcAddress rather than dlsym matters because it
         * returns Mesa's real entry points, not glvnd dispatch stubs. */
        static void *handle;
        if (!handle) {
            handle = dlopen("libOSMesa.so.8", RTLD_LAZY | RTLD_GLOBAL);
            if (!handle)
                handle = dlopen("libOSMesa.so", RTLD_LAZY | RTLD_GLOBAL);
        }
        if (handle)
            *(void **)&osmesa_get_proc = dlsym(handle, "OSMesaGetProcAddress");
        if (!osmesa_get_proc)
            return NULL;
    }
    return osmesa_get_proc(name);
}

/* ---- fake GLX: just enough for a GLX-built GLEW's glxewInit ---- */

static int fake_display_storage;

void *glXGetCurrentDisplay(void) { return &fake_display_storage; }
void *glXGetCurrentContext(void) { return &fake_display_storage; }

int glXQueryVersion(void *dpy, int *major, int *minor)
{
    (void)dpy;
    if (major) *major = 1;
    if (minor) *minor = 4;
    return 1;
}

const char *glXGetClientString(void *dpy, int name) { (void)dpy; (void)name; return ""; }
const char *glXQueryExtensionsString(void *dpy, int screen) { (void)dpy; (void)screen; return ""; }
void glXSwapBuffers(void *dpy, unsigned long drawable) { (void)dpy; (void)drawable; }

typedef void (*glx_proc_t)(void);

glx_proc_t glXGetProcAddressARB(const GLubyte *name)
{
    const char *n = (const char *)name;
    if (!n) return NULL;
    if (n[0] == 'g' && n[1] == 'l' && n[2] == 'X') {
        /* Fakes above win (the shim precedes libGL in the lookup scope); other glX
         * names fall through to libGL's real exports. GLEW only ever CALLS the faked
         * ones — the rest are resolved, stored, and left alone by the CLI path. */
        return (glx_proc_t)dlsym(RTLD_DEFAULT, n);
    }
    return (glx_proc_t)osmesa_proc(n);
}

glx_proc_t glXGetProcAddress(const GLubyte *name) { return glXGetProcAddressARB(name); }

/* ---- GL 1.1 forwarders for every gl* symbol the binary imports directly ---- */

#define FWD_VOID(name, params, args)                                    \
    void name params                                                    \
    {                                                                   \
        static void (*p) params;                                        \
        if (!p) *(void **)&p = osmesa_proc(#name);                      \
        if (p) p args;                                                  \
    }

#define FWD_RET(ret, name, params, args, fallback)                      \
    ret name params                                                     \
    {                                                                   \
        static ret (*p) params;                                         \
        if (!p) *(void **)&p = osmesa_proc(#name);                      \
        return p ? p args : (fallback);                                 \
    }

FWD_VOID(glBegin, (GLenum a), (a))
FWD_VOID(glBindTexture, (GLenum a, GLuint b), (a, b))
FWD_VOID(glBlendFunc, (GLenum a, GLenum b), (a, b))
FWD_VOID(glClear, (GLbitfield a), (a))
FWD_VOID(glClearColor, (GLfloat a, GLfloat b, GLfloat c, GLfloat d), (a, b, c, d))
FWD_VOID(glClearDepth, (GLdouble a), (a))
FWD_VOID(glColor3f, (GLfloat a, GLfloat b, GLfloat c), (a, b, c))
FWD_VOID(glColor3fv, (const GLfloat *a), (a))
FWD_VOID(glColor4f, (GLfloat a, GLfloat b, GLfloat c, GLfloat d), (a, b, c, d))
FWD_VOID(glColor4fv, (const GLfloat *a), (a))
FWD_VOID(glColorMask, (GLboolean a, GLboolean b, GLboolean c, GLboolean d), (a, b, c, d))
FWD_VOID(glColorMaterial, (GLenum a, GLenum b), (a, b))
FWD_VOID(glCullFace, (GLenum a), (a))
FWD_VOID(glDeleteTextures, (GLsizei a, const GLuint *b), (a, b))
FWD_VOID(glDepthFunc, (GLenum a), (a))
FWD_VOID(glDepthMask, (GLboolean a), (a))
FWD_VOID(glDisable, (GLenum a), (a))
FWD_VOID(glDisableClientState, (GLenum a), (a))
FWD_VOID(glDrawElements, (GLenum a, GLsizei b, GLenum c, const void *d), (a, b, c, d))
FWD_VOID(glEnable, (GLenum a), (a))
FWD_VOID(glEnableClientState, (GLenum a), (a))
FWD_VOID(glEnd, (void), ())
FWD_VOID(glFlush, (void), ())
FWD_VOID(glFrontFace, (GLenum a), (a))
FWD_VOID(glFrustum, (GLdouble a, GLdouble b, GLdouble c, GLdouble d, GLdouble e, GLdouble f), (a, b, c, d, e, f))
FWD_VOID(glGenTextures, (GLsizei a, GLuint *b), (a, b))
FWD_VOID(glGetBooleanv, (GLenum a, GLboolean *b), (a, b))
FWD_RET(GLenum, glGetError, (void), (), 0)
FWD_VOID(glGetFloatv, (GLenum a, GLfloat *b), (a, b))
FWD_VOID(glGetIntegerv, (GLenum a, GLint *b), (a, b))
FWD_RET(const GLubyte *, glGetString, (GLenum a), (a), NULL)
FWD_VOID(glGetTexImage, (GLenum a, GLint b, GLenum c, GLenum d, void *e), (a, b, c, d, e))
FWD_VOID(glHint, (GLenum a, GLenum b), (a, b))
FWD_VOID(glIndexi, (GLint a), (a))
FWD_RET(GLboolean, glIsEnabled, (GLenum a), (a), 0)
FWD_VOID(glLightfv, (GLenum a, GLenum b, const GLfloat *c), (a, b, c))
FWD_VOID(glLineStipple, (GLint a, GLushort b), (a, b))
FWD_VOID(glLineWidth, (GLfloat a), (a))
FWD_VOID(glLoadIdentity, (void), ())
FWD_VOID(glMatrixMode, (GLenum a), (a))
FWD_VOID(glMultMatrixf, (const GLfloat *a), (a))
FWD_VOID(glNormal3f, (GLfloat a, GLfloat b, GLfloat c), (a, b, c))
FWD_VOID(glNormal3fv, (const GLfloat *a), (a))
FWD_VOID(glOrtho, (GLdouble a, GLdouble b, GLdouble c, GLdouble d, GLdouble e, GLdouble f), (a, b, c, d, e, f))
FWD_VOID(glPixelStorei, (GLenum a, GLint b), (a, b))
FWD_VOID(glPolygonMode, (GLenum a, GLenum b), (a, b))
FWD_VOID(glPopAttrib, (void), ())
FWD_VOID(glPopMatrix, (void), ())
FWD_VOID(glPushAttrib, (GLbitfield a), (a))
FWD_VOID(glPushMatrix, (void), ())
FWD_VOID(glReadPixels, (GLint a, GLint b, GLsizei c, GLsizei d, GLenum e, GLenum f, void *g), (a, b, c, d, e, f, g))
FWD_VOID(glRotated, (GLdouble a, GLdouble b, GLdouble c, GLdouble d), (a, b, c, d))
FWD_VOID(glRotatef, (GLfloat a, GLfloat b, GLfloat c, GLfloat d), (a, b, c, d))
FWD_VOID(glScissor, (GLint a, GLint b, GLsizei c, GLsizei d), (a, b, c, d))
FWD_VOID(glStencilFunc, (GLenum a, GLint b, GLuint c), (a, b, c))
FWD_VOID(glStencilMask, (GLuint a), (a))
FWD_VOID(glStencilOp, (GLenum a, GLenum b, GLenum c), (a, b, c))
FWD_VOID(glTexCoord2f, (GLfloat a, GLfloat b), (a, b))
FWD_VOID(glTexCoord2fv, (const GLfloat *a), (a))
FWD_VOID(glTexEnvi, (GLenum a, GLenum b, GLint c), (a, b, c))
FWD_VOID(glTexImage2D, (GLenum a, GLint b, GLint c, GLsizei d, GLsizei e, GLint f, GLenum g, GLenum h, const void *i), (a, b, c, d, e, f, g, h, i))
FWD_VOID(glTexParameterf, (GLenum a, GLenum b, GLfloat c), (a, b, c))
FWD_VOID(glTexParameteri, (GLenum a, GLenum b, GLint c), (a, b, c))
FWD_VOID(glTexSubImage2D, (GLenum a, GLint b, GLint c, GLint d, GLsizei e, GLsizei f, GLenum g, GLenum h, const void *i), (a, b, c, d, e, f, g, h, i))
FWD_VOID(glTranslated, (GLdouble a, GLdouble b, GLdouble c), (a, b, c))
FWD_VOID(glTranslatef, (GLfloat a, GLfloat b, GLfloat c), (a, b, c))
FWD_VOID(glVertex2f, (GLfloat a, GLfloat b), (a, b))
FWD_VOID(glVertex3f, (GLfloat a, GLfloat b, GLfloat c), (a, b, c))
FWD_VOID(glVertex3fv, (const GLfloat *a), (a))
FWD_VOID(glVertexPointer, (GLint a, GLenum b, GLsizei c, const void *d), (a, b, c, d))
FWD_VOID(glViewport, (GLint a, GLint b, GLsizei c, GLsizei d), (a, b, c, d))
