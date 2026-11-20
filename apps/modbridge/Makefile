# modbridge: kaiHEN homebrew (Switch 2). Build: make, in the ounce-devkit Docker image.
ifeq ($(strip $(DEVKITPRO)),)
$(error "Please set DEVKITPRO in your environment")
endif

TARGET := modbridge
BUILD := build
PREFIX := $(DEVKITPRO)/devkitA64/bin/aarch64-none-elf-
include $(DEVKITPRO)/libounce/switch2_cpu.mk
ARCH := $(SWITCH2_CPU) -mtp=soft -fPIE
CFLAGS := $(ARCH) -std=gnu11 -O2 -Wall -Wextra -ffunction-sections -fdata-sections \
    -D__SWITCH__ -D__SWITCH2__ \
    -I$(DEVKITPRO)/portlibs/switch2/include -I$(DEVKITPRO)/libounce/include
LDFLAGS := $(ARCH) -specs=$(DEVKITPRO)/libounce/switch.specs -Wl,--gc-sections
LIBS := -L$(DEVKITPRO)/portlibs/switch2/lib -L$(DEVKITPRO)/libounce/lib -lkaihen -lnx

all: $(TARGET).nro

$(BUILD):
	mkdir -p $@

$(BUILD)/main.o: source/main.c | $(BUILD)
	$(PREFIX)gcc $(CFLAGS) -c $< -o $@

$(BUILD)/$(TARGET).elf: $(BUILD)/main.o
	$(PREFIX)gcc $(LDFLAGS) $^ $(LIBS) -o $@

$(BUILD)/$(TARGET).nacp: | $(BUILD)
	$(DEVKITPRO)/tools/bin/nacptool --create "Mod Bridge" "switch2-scripts" "0.1" $@

$(TARGET).nro: $(BUILD)/$(TARGET).elf $(BUILD)/$(TARGET).nacp
	$(DEVKITPRO)/tools/bin/elf2nro $< $@ --nacp=$(BUILD)/$(TARGET).nacp --icon=$(DEVKITPRO)/libounce/default_icon.jpg

clean:
	rm -rf $(BUILD) $(TARGET).nro

.PHONY: all clean
