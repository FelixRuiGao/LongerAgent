const std = @import("std");

pub const MisalignU8Allocator = struct {
    backing: std.mem.Allocator,

    pub fn init(backing: std.mem.Allocator) MisalignU8Allocator {
        return .{ .backing = backing };
    }

    pub fn allocator(self: *MisalignU8Allocator) std.mem.Allocator {
        return .{
            .ptr = self,
            .vtable = &.{
                .alloc = alloc,
                .resize = resize,
                .remap = remap,
                .free = free,
            },
        };
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ret_addr: usize) ?[*]u8 {
        const self: *MisalignU8Allocator = @ptrCast(@alignCast(ctx));

        if (alignment == .@"1") {
            const raw = self.backing.rawAlloc(len + 1, alignment, ret_addr) orelse return null;
            return raw + 1;
        }

        return self.backing.rawAlloc(len, alignment, ret_addr);
    }

    fn resize(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ret_addr: usize) bool {
        _ = ctx;
        _ = memory;
        _ = alignment;
        _ = new_len;
        _ = ret_addr;
        return false;
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ret_addr: usize) ?[*]u8 {
        _ = ctx;
        _ = memory;
        _ = alignment;
        _ = new_len;
        _ = ret_addr;
        return null;
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret_addr: usize) void {
        const self: *MisalignU8Allocator = @ptrCast(@alignCast(ctx));

        if (alignment == .@"1") {
            const raw_ptr: [*]u8 = @ptrFromInt(@intFromPtr(memory.ptr) - 1);
            self.backing.rawFree(raw_ptr[0 .. memory.len + 1], alignment, ret_addr);
            return;
        }

        self.backing.rawFree(memory, alignment, ret_addr);
    }
};
